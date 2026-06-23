//! Client for Fuzzwork's market **aggregates** API, which returns per-type
//! buy/sell summaries (min/max/weighted-average/percentile/volume) for a whole
//! region or a single station — in batched calls. This is what lets us price
//! the entire manufacturable catalogue at a chosen market.

use std::collections::HashMap;

use serde::Deserialize;

use crate::esi::{EsiError, USER_AGENT};

use super::markets::Location;

const BASE: &str = "https://market.fuzzwork.co.uk/aggregates/";
/// Fuzzwork handles a few hundred type ids per request comfortably.
const BATCH: usize = 250;

/// One side (buy or sell) of the aggregated order book.
#[derive(Debug, Clone)]
pub struct Side {
    pub min: f64,
    pub max: f64,
    pub weighted_average: f64,
    /// The 5th/95th-percentile price — the "realistic" price ignoring outliers.
    pub percentile: f64,
    /// Volume currently on the market (liquidity).
    pub volume: f64,
    pub order_count: i64,
}

#[derive(Debug, Clone)]
pub struct Aggregate {
    pub buy: Side,
    pub sell: Side,
}

// Fuzzwork encodes every number as a JSON string, so deserialize as strings and
// parse.
#[derive(Deserialize)]
struct RawSide {
    #[serde(rename = "weightedAverage")]
    weighted_average: String,
    max: String,
    min: String,
    volume: String,
    #[serde(rename = "orderCount")]
    order_count: String,
    percentile: String,
}

#[derive(Deserialize)]
struct RawAggregate {
    buy: RawSide,
    sell: RawSide,
}

fn parse(s: &str) -> f64 {
    s.parse().unwrap_or(0.0)
}

impl From<RawSide> for Side {
    fn from(r: RawSide) -> Self {
        Side {
            min: parse(&r.min),
            max: parse(&r.max),
            weighted_average: parse(&r.weighted_average),
            percentile: parse(&r.percentile),
            volume: parse(&r.volume),
            order_count: parse(&r.order_count) as i64,
        }
    }
}

pub struct FuzzworkClient {
    http: reqwest::Client,
}

impl Default for FuzzworkClient {
    fn default() -> Self {
        Self::new()
    }
}

impl FuzzworkClient {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .build()
            .expect("failed to build HTTP client");
        Self { http }
    }

    /// Aggregates for the given type ids at a location, fetched in batches.
    pub async fn aggregates(
        &self,
        location: Location,
        type_ids: &[i64],
    ) -> Result<HashMap<i64, Aggregate>, EsiError> {
        let (param, id) = location.query_param();
        let mut out = HashMap::with_capacity(type_ids.len());
        for chunk in type_ids.chunks(BATCH) {
            let types = chunk
                .iter()
                .map(|t| t.to_string())
                .collect::<Vec<_>>()
                .join(",");
            let raw: HashMap<String, RawAggregate> = self
                .http
                .get(BASE)
                .query(&[(param, id.to_string()), ("types", types)])
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            for (key, value) in raw {
                if let Ok(type_id) = key.parse::<i64>() {
                    out.insert(
                        type_id,
                        Aggregate {
                            buy: value.buy.into(),
                            sell: value.sell.into(),
                        },
                    );
                }
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fuzzwork_string_numbers() {
        let json = r#"{
            "34": {
                "buy": {"weightedAverage":"2.19","max":"3.62","min":"0.01","stddev":"0.9","median":"3.19","volume":"12200731494.0","orderCount":"40","percentile":"3.52"},
                "sell": {"weightedAverage":"3.99","max":"55000.0","min":"3.68","stddev":"6436.9","median":"4.14","volume":"18785145164.0","orderCount":"73","percentile":"3.69"}
            }
        }"#;
        let raw: HashMap<String, RawAggregate> = serde_json::from_str(json).unwrap();
        let agg: Aggregate = {
            let v = raw.into_iter().next().unwrap().1;
            Aggregate {
                buy: v.buy.into(),
                sell: v.sell.into(),
            }
        };
        assert_eq!(agg.sell.min, 3.68);
        assert_eq!(agg.buy.max, 3.62);
        assert_eq!(agg.sell.percentile, 3.69);
        assert_eq!(agg.sell.order_count, 73);
        assert_eq!(agg.sell.volume, 18785145164.0);
    }
}
