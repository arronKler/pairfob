//! The link under a pointer: an OSC 8 cell first, then a URL-shaped run of
//! plain text inside the same pane.

use std::process::Command;

use crate::model::{Frame, PaneRect};

/// The link a click at `(x, y)` should open. An OSC 8 cell wins over plain
/// text that only looks like a URL.
pub fn link_at(frame: &Frame, pane: &PaneRect, x: u16, y: u16) -> Option<String> {
    if !pane.rect.contains(x, y) {
        return None;
    }
    let embedded = frame
        .cell(x, y)
        .and_then(|cell| cell.link)
        .and_then(|index| frame.links.get(index as usize))
        .filter(|url| !url.is_empty());
    if let Some(url) = embedded {
        return Some(url.clone());
    }
    plain_url_at(frame, pane, x, y)
}

/// Opens a URL with the platform's handler. Only `http` and `https` cross this
/// boundary; the URL is one argv element and never reaches a shell.
pub fn open_external(url: &str) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(format!(
            "refusing to open {url}: only http and https links open"
        ));
    }
    if url.chars().any(|ch| ch.is_whitespace() || ch.is_control()) {
        return Err(format!(
            "refusing to open {url}: whitespace or control bytes"
        ));
    }
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let status = Command::new(opener)
        .arg(url)
        .status()
        .map_err(|error| format!("{opener}: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{opener} exited with {status}"))
    }
}

fn plain_url_at(frame: &Frame, pane: &PaneRect, x: u16, y: u16) -> Option<String> {
    let mut text = String::new();
    let mut starts = Vec::new();
    for column in pane.rect.x..pane.rect.right().min(frame.size.cols) {
        let Some(cell) = frame.cell(column, y) else {
            break;
        };
        if cell.skip || cell.symbol.is_empty() {
            continue;
        }
        starts.push((text.len(), column));
        text.push_str(&cell.symbol);
    }

    for (index, &(start, start_col)) in starts.iter().enumerate() {
        let rest = &text[start..];
        if !(rest.starts_with("http://") || rest.starts_with("https://")) {
            continue;
        }
        let end = rest
            .char_indices()
            .find_map(|(offset, ch)| (!is_url_char(ch)).then_some(start + offset))
            .unwrap_or(text.len());
        let end_col = starts[index..]
            .iter()
            .take_while(|&&(offset, _)| offset < end)
            .last()
            .map(|&(_, column)| column)
            .unwrap_or(start_col);
        if x >= start_col && x <= end_col {
            return Some(text[start..end].to_owned());
        }
    }
    None
}

fn is_url_char(ch: char) -> bool {
    !ch.is_whitespace() && !ch.is_control() && !matches!(ch, '<' | '>' | '"')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Cell, Rect, Size};

    fn cell(symbol: &str) -> Cell {
        Cell {
            symbol: symbol.into(),
            ..Cell::default()
        }
    }

    fn frame_of(rows: &[&str]) -> Frame {
        let cols = rows
            .iter()
            .map(|row| row.chars().count())
            .max()
            .unwrap_or(0) as u16;
        let mut cells = Vec::new();
        for row in rows {
            let mut row_cells: Vec<Cell> = row.chars().map(|ch| cell(&ch.to_string())).collect();
            row_cells.resize(usize::from(cols), Cell::default());
            cells.extend(row_cells);
        }
        Frame {
            size: Size::new(cols, rows.len() as u16),
            cells,
            ..Frame::default()
        }
    }

    fn pane(rect: Rect) -> PaneRect {
        PaneRect {
            id: "p".into(),
            rect,
            focused: true,
            alternate_screen: false,
            mouse_reporting: false,
            scroll: None,
            content_revision: 0,
        }
    }

    fn full(frame: &Frame) -> PaneRect {
        pane(Rect {
            x: 0,
            y: 0,
            width: frame.size.cols,
            height: frame.size.rows,
        })
    }

    #[test]
    fn a_plain_url_is_found_from_its_first_to_its_last_cell() {
        let frame = frame_of(&["http://a.example x"]);
        let pane = full(&frame);
        let url = "http://a.example";
        assert_eq!(link_at(&frame, &pane, 0, 0).as_deref(), Some(url));
        assert_eq!(link_at(&frame, &pane, 8, 0).as_deref(), Some(url));
        assert_eq!(link_at(&frame, &pane, 15, 0).as_deref(), Some(url));
        assert_eq!(link_at(&frame, &pane, 16, 0), None);
    }

    #[test]
    fn a_url_in_the_middle_or_at_the_end_is_found_by_any_of_its_cells() {
        let frame = frame_of(&["see https://mid.example now"]);
        let pane = full(&frame);
        assert_eq!(
            link_at(&frame, &pane, 12, 0).as_deref(),
            Some("https://mid.example")
        );

        let frame = frame_of(&["tail https://end.example"]);
        let pane = full(&frame);
        assert_eq!(
            link_at(&frame, &pane, frame.size.cols - 1, 0).as_deref(),
            Some("https://end.example")
        );
    }

    #[test]
    fn a_url_clipped_by_the_pane_edge_stops_at_the_edge() {
        let frame = frame_of(&["https://example.com"]);
        let pane = pane(Rect {
            x: 0,
            y: 0,
            width: 10,
            height: 1,
        });
        assert_eq!(link_at(&frame, &pane, 9, 0).as_deref(), Some("https://ex"));
        assert_eq!(link_at(&frame, &pane, 10, 0), None);
    }

    #[test]
    fn an_osc8_cell_wins_over_plain_text() {
        let mut frame = frame_of(&["https://plain.example"]);
        frame.cells[0].link = Some(0);
        frame.links.push("https://osc.example".into());
        let pane = full(&frame);
        assert_eq!(
            link_at(&frame, &pane, 0, 0).as_deref(),
            Some("https://osc.example")
        );
        assert_eq!(
            link_at(&frame, &pane, 3, 0).as_deref(),
            Some("https://plain.example")
        );
    }

    #[test]
    fn text_without_a_url_has_no_link() {
        let frame = frame_of(&["plain text here"]);
        let pane = full(&frame);
        assert_eq!(link_at(&frame, &pane, 3, 0), None);
        assert_eq!(link_at(&frame, &pane, 3, 1), None);

        let frame = frame_of(&["xhttp://a.example"]);
        let pane = full(&frame);
        assert_eq!(
            link_at(&frame, &pane, 3, 0).as_deref(),
            Some("http://a.example")
        );

        let frame = Frame {
            size: Size::new(1, 1),
            cells: vec![cell("xhttp://a.example")],
            ..Frame::default()
        };
        let pane = full(&frame);
        assert_eq!(link_at(&frame, &pane, 0, 0), None);
    }

    #[test]
    fn a_wide_glyphs_continuation_cell_does_not_break_a_url() {
        let mut cells: Vec<Cell> = "http://e".chars().map(|ch| cell(&ch.to_string())).collect();
        cells.push(Cell {
            symbol: " ".into(),
            skip: true,
            ..Cell::default()
        });
        cells.push(cell("x"));
        let frame = Frame {
            size: Size::new(cells.len() as u16, 1),
            cells,
            ..Frame::default()
        };
        let pane = full(&frame);
        assert_eq!(link_at(&frame, &pane, 9, 0).as_deref(), Some("http://ex"));
    }

    #[test]
    fn only_http_urls_without_whitespace_or_controls_open() {
        assert!(open_external("javascript:alert(1)").is_err());
        assert!(open_external("file:///etc/passwd").is_err());
        assert!(open_external("ftp://example.com").is_err());
        assert!(open_external("https://example.com/a b").is_err());
        assert!(open_external("https://example.com/\n").is_err());
    }
}
