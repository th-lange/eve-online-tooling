//! Tauri command surface for the Mass Production module (#883).

use std::collections::HashMap;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::esi::commands::owned_blueprints_core;
use crate::esi::AuthState;
use crate::modules::production::required_quantity;
use crate::sde::BlueprintMaterial;

/// One pasted blueprint name resolved against the SDE, with what's actually
/// owned across the roster/corp hangars.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchedBlueprint {
    /// Resolved SDE type name (not the raw pasted line — normalizes case/
    /// whitespace the same way every other paste-import command does).
    pub name: String,
    pub type_id: i64,
    /// Total physical BPC copies owned across the roster/corp hangars.
    /// Excludes BPOs (`runs == -1`) — a BPO has no bounded "remaining runs"
    /// to sum, so it never contributes to `total_runs` or the materials
    /// below.
    pub owned_copies: i64,
    /// Sum of `runs` across every owned copy (a stack of N identical copies
    /// at R runs each counts as `N * R`).
    pub total_runs: i64,
}

/// One material line inside a [`MaterialGroup`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub type_id: i64,
    pub name: String,
    pub quantity: i64,
}

/// Aggregated materials for one `invGroups.groupName` bucket (e.g. "Mineral",
/// "Refined Commodities - Tier 2") — finer than category, which is what
/// actually separates PI tiers, minerals, and composites from each other.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialGroup {
    pub group_name: String,
    /// The group's parent `invCategories.categoryName`, for a secondary label.
    pub category_name: String,
    pub items: Vec<PlanItem>,
}

/// Result of `massprod_plan`: what didn't resolve, what was matched against
/// owned copies, and the materials to buy, grouped for Multibuy.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MassProductionPlan {
    /// Pasted lines that matched no SDE type name.
    pub unresolved_names: Vec<String>,
    pub matched_blueprints: Vec<MatchedBlueprint>,
    pub groups: Vec<MaterialGroup>,
}

/// Sum of ME-adjusted material requirements across every owned run-limited
/// copy of one blueprint type. Each `(runs, me, count)` tuple is a stack of
/// `count` identical copies (ESI already merges identical untouched BPCs
/// under one row's `quantity`) — every stack's per-copy requirement is
/// computed independently at its own ME/runs via [`required_quantity`], then
/// summed. Copies at different ME/runs are not fungible, so this must never
/// collapse to an average across copies (#883). Pure — no SDE/network access
/// — so it's unit-tested directly.
fn sum_copy_materials(
    materials: &[BlueprintMaterial],
    copies: &[(i64, i64, i64)], // (runs, material_efficiency, count)
) -> HashMap<i64, i64> {
    let mut totals: HashMap<i64, i64> = HashMap::new();
    for &(runs, me, count) in copies {
        if runs <= 0 || count <= 0 {
            continue;
        }
        for m in materials {
            let per_copy = required_quantity(m.quantity, runs, me, 1.0);
            *totals.entry(m.material_type_id).or_insert(0) += per_copy * count;
        }
    }
    totals
}

/// A stack's copy count: a positive `quantity` is a real stack of identical
/// copies; `-2` (single BPC) and `-1` (BPO, filtered out before this by its
/// `runs`) both count as one physical item.
fn stack_count(quantity: i64) -> i64 {
    if quantity > 0 {
        quantity
    } else {
        1
    }
}

/// Resolved blueprint names: pasted-line resolution order (type ids, first
/// seen), the resolved name for each, and every pasted line that resolved to
/// nothing.
type ResolvedBlueprintNames = (Vec<i64>, HashMap<i64, String>, Vec<String>);

/// Resolve every pasted line to an SDE type id, in first-seen order,
/// de-duplicating repeated names (case/whitespace already normalized by
/// `type_by_name`'s case-insensitive match). Blank lines are skipped. Lines
/// that don't resolve to any type are returned as `unresolved_names`, the
/// same reporting shape `shopping_add_text` already uses.
fn resolve_blueprint_names(
    sde: &crate::sde::Sde,
    blueprint_names: &[String],
) -> Result<ResolvedBlueprintNames, String> {
    let mut order = Vec::new();
    let mut names: HashMap<i64, String> = HashMap::new();
    let mut unresolved = Vec::new();
    for raw in blueprint_names {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        match sde.type_by_name(line).map_err(|e| e.to_string())? {
            Some((type_id, _volume)) => {
                if let std::collections::hash_map::Entry::Vacant(e) = names.entry(type_id) {
                    order.push(type_id);
                    e.insert(sde.type_name_or_id(type_id));
                }
            }
            None => unresolved.push(raw.clone()),
        }
    }
    Ok((order, names, unresolved))
}

/// Paste a list of blueprint names (one per line) and get a Mass Production
/// plan: each name matched against every copy the roster/corp actually own
/// (real ME/runs, personal + corp hangars), the resulting materials summed
/// per owned copy (#883's reference behavior — never averaged across copies
/// at different ME/runs), and bucketed by `invGroups.groupName` into
/// Multibuy-ready shopping groups.
#[tauri::command]
pub async fn massprod_plan(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    blueprint_names: Vec<String>,
) -> Result<MassProductionPlan, crate::model::AppError> {
    let (dir, sde) = crate::sde::dir_and_sde(&app)?;

    let (order, names, unresolved_names) = resolve_blueprint_names(&sde, &blueprint_names)?;

    let owned = owned_blueprints_core(&dir, &auth_state).await?;
    let mut owned_by_type: HashMap<i64, Vec<(i64, i64, i64)>> = HashMap::new();
    for bp in &owned {
        owned_by_type.entry(bp.type_id).or_default().push((
            bp.runs,
            bp.material_efficiency,
            stack_count(bp.quantity),
        ));
    }

    let mut matched_blueprints = Vec::with_capacity(order.len());
    let mut material_totals: HashMap<i64, i64> = HashMap::new();

    for type_id in &order {
        let copies = owned_by_type.get(type_id).cloned().unwrap_or_default();
        let owned_copies: i64 = copies
            .iter()
            .filter(|&&(runs, _, _)| runs > 0)
            .map(|&(_, _, count)| count)
            .sum();
        let total_runs: i64 = copies
            .iter()
            .filter(|&&(runs, _, _)| runs > 0)
            .map(|&(runs, _, count)| runs * count)
            .sum();

        matched_blueprints.push(MatchedBlueprint {
            name: names[type_id].clone(),
            type_id: *type_id,
            owned_copies,
            total_runs,
        });

        if owned_copies > 0 {
            let materials = sde
                .blueprint_materials(*type_id)
                .map_err(|e| e.to_string())?;
            for (material_type_id, qty) in sum_copy_materials(&materials, &copies) {
                *material_totals.entry(material_type_id).or_insert(0) += qty;
            }
        }
    }

    let group_names = crate::sde::cached_group_names(&dir)?;
    let category_names = crate::sde::cached_category_names(&dir)?;
    let mut groups_by_name: HashMap<String, MaterialGroup> = HashMap::new();
    for (type_id, quantity) in material_totals {
        let group_name = group_names
            .get(&type_id)
            .cloned()
            .unwrap_or_else(|| "Other".to_string());
        let category_name = category_names.get(&type_id).cloned().unwrap_or_default();
        groups_by_name
            .entry(group_name.clone())
            .or_insert_with(|| MaterialGroup {
                group_name,
                category_name,
                items: Vec::new(),
            })
            .items
            .push(PlanItem {
                type_id,
                name: sde.type_name_or_id(type_id),
                quantity,
            });
    }

    let mut groups: Vec<MaterialGroup> = groups_by_name.into_values().collect();
    for g in &mut groups {
        g.items.sort_by(|a, b| a.name.cmp(&b.name));
    }
    groups.sort_by(|a, b| a.group_name.cmp(&b.group_name));

    Ok(MassProductionPlan {
        unresolved_names,
        matched_blueprints,
        groups,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn material(type_id: i64, quantity: i64) -> BlueprintMaterial {
        BlueprintMaterial {
            material_type_id: type_id,
            name: format!("Material {type_id}"),
            quantity,
        }
    }

    #[test]
    fn sums_per_copy_instead_of_averaging_me_and_runs() {
        // Two copies of the same blueprint at different ME/runs: 1 copy at
        // ME0/10 runs, 1 copy at ME10/5 runs. A base quantity of 100.
        let materials = vec![material(11399, 100)];
        let copies = vec![(10, 0, 1), (5, 10, 1)];

        let totals = sum_copy_materials(&materials, &copies);

        // Correct (per-copy, summed): ceil(100*10*1.0) + ceil(100*5*0.9)
        //   = 1000 + 450 = 1450.
        // Wrong (averaged runs=7.5, me=5 first): ceil(100*7.5*0.95) = 713,
        // a materially different (and lower) number — this is the bug #883
        // explicitly calls out.
        assert_eq!(totals[&11399], 1450);
    }

    #[test]
    fn stacked_identical_copies_multiply_by_count() {
        // A stack of 30 identical BPCs at ME2/runs10 (ESI's `quantity` field
        // for an untouched stack), base material quantity 17 (Morphite on a
        // real T2 blueprint).
        let materials = vec![material(11399, 17)];
        let copies = vec![(10, 2, 30)];

        let totals = sum_copy_materials(&materials, &copies);

        // Per copy: ceil(17*10*0.98) = ceil(166.6) = 167; times 30 copies.
        assert_eq!(totals[&11399], 167 * 30);
    }

    #[test]
    fn bpos_and_empty_stacks_are_excluded() {
        let materials = vec![material(1, 5)];
        // runs = -1 marks a BPO (unbounded); count = 0 is a degenerate stack.
        let copies = vec![(-1, 0, 1), (10, 0, 0)];

        let totals = sum_copy_materials(&materials, &copies);

        assert!(totals.is_empty());
    }

    #[test]
    fn stack_count_treats_negative_quantities_as_one() {
        assert_eq!(stack_count(-2), 1); // single BPC
        assert_eq!(stack_count(-1), 1); // BPO (filtered by runs elsewhere)
        assert_eq!(stack_count(12), 12); // real stack
    }
}
