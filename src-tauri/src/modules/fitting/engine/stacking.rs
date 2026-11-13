//! Stacking-penalty math (#170) — pure.
//!
//! EVE penalizes successive multiplicative bonuses to the same (non-stackable)
//! attribute: each additional module of the same kind is less effective. The
//! i-th (0-based) penalized modifier's effectiveness is `exp(-((i/2.67)^2))`,
//! giving the familiar sequence 100%, 86.9%, 57.1%, 28.3%, 10.6%, 3.0%, …

/// Effectiveness multiplier of the `index`-th (0-based) penalized modifier.
pub fn penalty(index: usize) -> f64 {
    let i = index as f64;
    (-(i / 2.67).powi(2)).exp()
}

/// Combine stacking-penalized multiplicative factors into one multiplier.
///
/// Bonuses (factor > 1) and penalties (factor < 1) are penalized in two
/// **separate** chains, as in EVE/pyfa: within each chain the factors are
/// sorted by descending deviation from 1.0 (strongest applied at full
/// strength) and each successive factor's deviation is attenuated by
/// [`penalty`]. Neutral factors (== 1.0) are skipped. Order-independent.
pub fn combine_penalized(factors: &[f64]) -> f64 {
    let (mut bonuses, mut penalties): (Vec<f64>, Vec<f64>) = factors
        .iter()
        .map(|&f| f - 1.0)
        .filter(|d| *d != 0.0)
        .partition(|d| *d > 0.0);
    chain(&mut bonuses) * chain(&mut penalties)
}

/// Penalize one same-sign chain of deviations (strongest first).
fn chain(deviations: &mut [f64]) -> f64 {
    deviations.sort_by(|a, b| {
        b.abs()
            .partial_cmp(&a.abs())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    deviations
        .iter()
        .enumerate()
        .fold(1.0, |acc, (i, dev)| acc * (1.0 + dev * penalty(i)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn penalty_sequence_matches_published_table() {
        let expected = [1.0, 0.8691, 0.5706, 0.2830, 0.1060];
        for (i, &want) in expected.iter().enumerate() {
            assert!(
                (penalty(i) - want).abs() < 1e-3,
                "penalty({i}) = {} != {want}",
                penalty(i)
            );
        }
    }

    #[test]
    fn combine_is_order_independent() {
        let a = combine_penalized(&[1.5, 1.3, 1.1]);
        let b = combine_penalized(&[1.1, 1.5, 1.3]);
        assert!((a - b).abs() < 1e-12);
    }

    #[test]
    fn first_factor_applies_fully_second_is_penalized() {
        // Two identical +50% bonuses: 1.5 fully, then 1 + 0.5*penalty(1).
        let got = combine_penalized(&[1.5, 1.5]);
        let want = 1.5 * (1.0 + 0.5 * penalty(1));
        assert!((got - want).abs() < 1e-12);
    }

    #[test]
    fn bonuses_and_penalties_use_separate_chains() {
        // Two +60% bonuses and two -60% (x0.4) penalties: each pair is its own chain.
        let got = combine_penalized(&[1.6, 0.4, 1.6, 0.4]);
        let bonus = 1.6 * (1.0 + 0.6 * penalty(1));
        let pen = 0.4 * (1.0 - 0.6 * penalty(1));
        assert!((got - bonus * pen).abs() < 1e-12);
        // A bonus must not push a penalty down the chain: 1.1 alongside 0.5 is untouched.
        assert!((combine_penalized(&[1.1, 0.5]) - 0.55).abs() < 1e-12);
    }

    #[test]
    fn empty_factors_are_neutral() {
        assert_eq!(combine_penalized(&[]), 1.0);
    }
}
