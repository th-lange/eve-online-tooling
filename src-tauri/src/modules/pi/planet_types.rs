//! Static planet-type → P0 raw-resource mapping (#882).
//!
//! This is **not** in the SDE export — there's no `planetResources`-equivalent
//! static table (the `planetResources`/"Reagent" system referenced by
//! `planetSchematics*` is a per-celestial thing used for Advanced/Custom's
//! Office resources, unrelated to the 8 fixed planet types' basic P0
//! resources). It's static game data, unchanged since the Tyrannis PI system;
//! cross-checked against `planetSchematicsTypeMap`'s actual P1 inputs and the
//! [EVE University Planetary Commodities table](https://wiki.eveuniversity.org/Planetary_Commodities).

/// `(planet type name, [5 P0 raw-resource type ids])`. Planet type names
/// match the ones ESI/the SDE's `invGroups` use for the `Planet` category
/// (also what [`super::commands::ColonyView::planet_type`] carries).
pub const PLANET_TYPE_RESOURCES: [(&str, [i64; 5]); 8] = [
    // Microorganisms, Carbon Compounds, Noble Metals, Base Metals, Aqueous Liquids
    ("Barren", [2073, 2288, 2270, 2267, 2268]),
    // Ionic Solutions, Reactive Gas, Noble Gas, Base Metals, Aqueous Liquids
    ("Gas", [2309, 2311, 2310, 2267, 2268]),
    // Microorganisms, Planktic Colonies, Noble Gas, Heavy Metals, Aqueous Liquids
    ("Ice", [2073, 2286, 2310, 2272, 2268]),
    // Non-CS Crystals, Suspended Plasma, Base Metals, Felsic Magma, Heavy Metals
    ("Lava", [2306, 2308, 2267, 2307, 2272]),
    // Microorganisms, Carbon Compounds, Planktic Colonies, Complex Organisms, Aqueous Liquids
    ("Oceanic", [2073, 2288, 2286, 2287, 2268]),
    // Non-CS Crystals, Suspended Plasma, Noble Metals, Base Metals, Heavy Metals
    ("Plasma", [2306, 2308, 2270, 2267, 2272]),
    // Ionic Solutions, Noble Gas, Suspended Plasma, Base Metals, Aqueous Liquids
    ("Storm", [2309, 2310, 2308, 2267, 2268]),
    // Microorganisms, Carbon Compounds, Autotrophs, Complex Organisms, Aqueous Liquids
    ("Temperate", [2073, 2288, 2305, 2287, 2268]),
];

/// The planet types that can extract the given P0 raw-resource type id
/// (empty if `type_id` isn't one of the 15 P0 resources), in
/// [`PLANET_TYPE_RESOURCES`] declaration order.
pub fn planet_types_for(type_id: i64) -> Vec<&'static str> {
    PLANET_TYPE_RESOURCES
        .iter()
        .filter(|(_, resources)| resources.contains(&type_id))
        .map(|(name, _)| *name)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_planet_type_has_exactly_five_resources_and_a_unique_name() {
        let mut names = std::collections::HashSet::new();
        for (name, resources) in PLANET_TYPE_RESOURCES {
            assert!(names.insert(name), "duplicate planet type {name}");
            let unique: std::collections::HashSet<_> = resources.iter().collect();
            assert_eq!(unique.len(), 5, "{name} has duplicate resource ids");
        }
        assert_eq!(names.len(), 8);
    }

    #[test]
    fn base_metals_found_on_five_planet_types() {
        // Base Metals (2267): Barren, Gas, Lava, Plasma, Storm.
        let planets = planet_types_for(2267);
        assert_eq!(planets, vec!["Barren", "Gas", "Lava", "Plasma", "Storm"]);
    }

    #[test]
    fn unknown_resource_has_no_planet_types() {
        assert!(planet_types_for(999_999).is_empty());
    }
}
