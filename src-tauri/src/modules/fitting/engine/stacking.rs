//! Stacking-penalty math (#170) — pure.
//!
//! EVE penalizes successive multiplicative bonuses to the same (non-stackable)
//! attribute: each additional module of the same kind is less effective. The
//! i-th (0-based) penalized modifier's effectiveness is `exp(-((i/2.67)^2))`,
//! giving the familiar sequence 100%, 86.9%, 57.1%, 28.3%, 10.6%, 3.0%, …
//!
//! Consumed by the attribute store (#170) and the stat calculators (#171+);
//! the module-level allow lets the core land ahead of those consumers.
#![allow(dead_code)]

/// Effectiveness multiplier of the `index`-th (0-based) penalized modifier.
pub fn penalty(index: usize) -> f64 {
    let i = index as f64;
    (-(i / 2.67).powi(2)).exp()
}

/// Combine stacking-penalized multiplicative factors into one multiplier.
///
/// Factors are sorted by descending deviation from 1.0 (strongest applied at
/// full strength), then each successive factor's *bonus* is attenuated by
/// [`penalty`]. Order-independent: shuffling the inputs yields the same result.
pub fn combine_penalized(factors: &[f64]) -> f64 {
    let mut deviations: Vec<f64> = factors.iter().map(|&f| f - 1.0).collect();
    // Strongest (largest |deviation|) first.
    deviations.sort_by(|a, b| {
        b.abs()
            .partial_cmp(&a.abs())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut result = 1.0;
    for (i, dev) in deviations.iter().enumerate() {
        result *= 1.0 + dev * penalty(i);
    }
    result
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
    fn empty_factors_are_neutral() {
        assert_eq!(combine_penalized(&[]), 1.0);
    }
}
