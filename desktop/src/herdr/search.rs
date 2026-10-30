//! `pane.copy_search` request and result shapes. Coordinates are absolute
//! screen-buffer cells counted from the top of the retained scrollback, so a
//! point stays put while the pane scrolls.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The daemon refuses longer queries with `query_too_large`; checking here
/// keeps an oversized paste off the wire.
pub const MAX_QUERY_BYTES: usize = 4096;

/// A cell in screen-buffer coordinates. Row first, so the derived order is
/// reading order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct TextPoint {
    pub row: u32,
    pub col: u16,
}

/// A span of cells. `end` is inclusive and names the last cell of the match.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextRange {
    pub start: TextPoint,
    pub end: TextPoint,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchDirection {
    /// Toward newer output: the first match starting after the origin.
    Forward,
    /// Toward older output: the last match ending before the origin.
    Backward,
}

/// `pane.copy_search` parameters. The origin is `previous` when given (its end
/// searching forward, its start backward), otherwise `cursor`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchRequest {
    pub pane_id: String,
    pub query: String,
    pub direction: SearchDirection,
    pub cursor: TextPoint,
    /// The pane content the coordinates were read from. The daemon answers
    /// `stale_content` when its terminal has moved on since.
    pub content_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous: Option<TextRange>,
}

impl SearchRequest {
    /// Rejects what the daemon would refuse before it is queued.
    pub fn validate(&self) -> Result<(), String> {
        if self.query.is_empty() {
            return Err("the search query is empty".into());
        }
        if self.query.len() > MAX_QUERY_BYTES {
            return Err(format!("the search query is over {MAX_QUERY_BYTES} bytes"));
        }
        Ok(())
    }
}

/// The prefix that marks a request ID as a search reply in the engine.
pub const REQUEST_ID_PREFIX: &str = "pfdesk-search-";

/// The wire ID a search travels under; its reply carries this back.
pub fn wire_id(request_id: u64) -> String {
    format!("{REQUEST_ID_PREFIX}{request_id}")
}

/// Recovers the caller's search ID from a reply's wire ID.
pub fn request_id(wire_id: &str) -> u64 {
    wire_id
        .strip_prefix(REQUEST_ID_PREFIX)
        .and_then(|id| id.parse().ok())
        .unwrap_or(0)
}

/// `pane.copy_search` result. `matches` is a bounded window around the current
/// match; `total` counts every match in the pane.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchResult {
    pub pane_id: String,
    pub content_revision: u64,
    pub matches: Vec<TextRange>,
    pub total: u64,
    /// Index of the current match within `matches`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<u32>,
    /// Index of the current match among all `total` matches, top first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_global: Option<u64>,
}

impl SearchResult {
    /// The current match, when the daemon named one inside `matches`.
    pub fn current_match(&self) -> Option<TextRange> {
        self.current
            .and_then(|index| usize::try_from(index).ok())
            .and_then(|index| self.matches.get(index))
            .copied()
    }
}

/// What one search round trip settled on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SearchOutcome {
    Found(SearchResult),
    /// The pane changed after `content_revision` was read; ask again with the
    /// revision the next frame carries.
    Stale,
    Failed {
        code: String,
        message: String,
    },
}

/// Decodes a `pane.copy_search` response envelope. A missing or foreign result
/// is a schema failure, never a panic.
pub fn parse_response(value: &Value) -> SearchOutcome {
    let Some(envelope) = value.as_object() else {
        return schema_failure("the response was not an object");
    };
    if let Some(error) = envelope.get("error") {
        let Some(error) = error.as_object() else {
            return schema_failure("the error was not an object");
        };
        let code = error.get("code").and_then(Value::as_str).unwrap_or("error");
        if code == "stale_content" {
            return SearchOutcome::Stale;
        }
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("no detail");
        return SearchOutcome::Failed {
            code: code.into(),
            message: message.into(),
        };
    }
    let Some(result) = envelope.get("result") else {
        return schema_failure("the response carried no result");
    };
    if result.get("type").and_then(Value::as_str) != Some("pane_copy_search") {
        return schema_failure("the result was not a pane_copy_search");
    }
    match serde_json::from_value::<SearchResult>(result.clone()) {
        Ok(result) => SearchOutcome::Found(result),
        Err(_) => schema_failure("the pane_copy_search result did not decode"),
    }
}

fn schema_failure(message: &str) -> SearchOutcome {
    SearchOutcome::Failed {
        code: "response_schema".into(),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn point(row: u32, col: u16) -> TextPoint {
        TextPoint { row, col }
    }

    fn range(start: (u32, u16), end: (u32, u16)) -> TextRange {
        TextRange {
            start: point(start.0, start.1),
            end: point(end.0, end.1),
        }
    }

    fn request(previous: Option<TextRange>) -> SearchRequest {
        SearchRequest {
            pane_id: "w1:p1".into(),
            query: "needle".into(),
            direction: SearchDirection::Backward,
            cursor: point(4, 2),
            content_revision: 9,
            previous,
        }
    }

    #[test]
    fn a_wire_id_round_trips_the_callers_id() {
        assert_eq!(request_id(&wire_id(7)), 7);
        assert_eq!(request_id("pfdesk-12"), 0);
        assert_eq!(request_id("pfdesk-search-nope"), 0);
    }

    #[test]
    fn a_request_serializes_the_contract_fields() {
        let value = serde_json::to_value(request(None)).unwrap();
        assert_eq!(value["direction"], "backward");
        assert_eq!(value["cursor"], json!({"row": 4, "col": 2}));
        assert!(value.get("previous").is_none());

        let value = serde_json::to_value(request(Some(range((3, 4), (3, 9))))).unwrap();
        assert_eq!(
            value["previous"],
            json!({"start": {"row": 3, "col": 4}, "end": {"row": 3, "col": 9}})
        );
    }

    #[test]
    fn validate_rejects_an_empty_or_oversized_query() {
        let mut request = request(None);
        request.query.clear();
        assert!(request.validate().is_err());

        request.query = "x".repeat(MAX_QUERY_BYTES + 1);
        assert!(request.validate().is_err());

        request.query = "x".repeat(MAX_QUERY_BYTES);
        assert!(request.validate().is_ok());
    }

    #[test]
    fn parses_a_result_and_its_current_match() {
        let response = json!({
            "id": "pfdesk-search-7",
            "result": {
                "type": "pane_copy_search",
                "pane_id": "w1:p1",
                "content_revision": 8,
                "matches": [
                    {"start": {"row": 1, "col": 0}, "end": {"row": 1, "col": 5}},
                    {"start": {"row": 9, "col": 2}, "end": {"row": 10, "col": 1}},
                ],
                "total": 7,
                "current": 1,
                "current_global": 4,
            }
        });
        let SearchOutcome::Found(result) = parse_response(&response) else {
            panic!("expected a found outcome");
        };
        assert_eq!(result.total, 7);
        assert_eq!(result.current_global, Some(4));
        assert_eq!(result.current_match(), Some(range((9, 2), (10, 1))));
    }

    #[test]
    fn an_absent_current_index_names_no_match() {
        let response = json!({"result": {
            "type": "pane_copy_search", "pane_id": "p",
            "content_revision": 2, "matches": [], "total": 0,
        }});
        let SearchOutcome::Found(result) = parse_response(&response) else {
            panic!("expected a found outcome");
        };
        assert_eq!(result.current_match(), None);
        assert_eq!(result.current_global, None);
    }

    #[test]
    fn stale_content_is_its_own_outcome() {
        let response = json!({"error": {"code": "stale_content", "message": "moved"}});
        assert_eq!(parse_response(&response), SearchOutcome::Stale);
    }

    #[test]
    fn other_errors_keep_their_code_and_message() {
        let response = json!({"error": {"code": "pane_not_found", "message": "gone"}});
        assert_eq!(
            parse_response(&response),
            SearchOutcome::Failed {
                code: "pane_not_found".into(),
                message: "gone".into(),
            }
        );
    }

    #[test]
    fn malformed_or_foreign_results_are_schema_failures() {
        for response in [
            json!({}),
            json!({"result": {"type": "pane_selection", "pane_id": "p", "text": ""}}),
            json!({"result": {"type": "pane_copy_search", "pane_id": "p"}}),
            json!({"result": "not an object"}),
            json!({"error": "not an object"}),
            json!("not an envelope"),
        ] {
            assert!(
                matches!(
                    parse_response(&response),
                    SearchOutcome::Failed { ref code, .. } if code == "response_schema"
                ),
                "{response}"
            );
        }
    }
}
