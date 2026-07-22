use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::mem;
use std::slice;

struct TextRun {
    str: String,
    x: f64,
    y: f64,
    baseline_tolerance: f64,
    utf16_length: usize,
}

impl TextRun {
    fn new(str: String, x: f64, y: f64, font_size: f64) -> Self {
        let scaled_font_size = font_size * 0.35;
        let baseline_tolerance = if scaled_font_size.is_nan() {
            f64::NAN
        } else {
            scaled_font_size.max(1.0)
        };
        let utf16_length = str.encode_utf16().count();
        Self {
            str,
            x,
            y,
            baseline_tolerance,
            utf16_length,
        }
    }
}

#[derive(PartialEq, Debug)]
struct LocatedCell {
    cell_index: usize,
    row_index: usize,
    x: f64,
    y: f64,
}

struct InputCursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> InputCursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn read_u32(&mut self, field: &str) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.read_exact(field)?))
    }

    fn read_f64(&mut self, field: &str) -> Result<f64, String> {
        Ok(f64::from_le_bytes(self.read_exact(field)?))
    }

    fn read_string(&mut self, field: &str) -> Result<String, String> {
        let length = self.read_u32(field)? as usize;
        let start = self.offset;
        let end = start
            .checked_add(length)
            .ok_or_else(|| format!("{field} length {length} overflows at byte {start}"))?;
        if end > self.bytes.len() {
            return Err(format!(
                "{field} needs {length} bytes at byte {start}, but only {} remain",
                self.bytes.len() - start
            ));
        }
        self.offset = end;
        std::str::from_utf8(&self.bytes[start..end])
            .map(str::to_owned)
            .map_err(|error| format!("{field} is not UTF-8 at byte {start}: {error}"))
    }

    fn finish(self, input_name: &str) -> Result<(), String> {
        if self.offset == self.bytes.len() {
            return Ok(());
        }
        Err(format!(
            "{input_name} has {} trailing bytes at byte {}",
            self.bytes.len() - self.offset,
            self.offset
        ))
    }

    fn remaining(&self) -> usize {
        self.bytes.len() - self.offset
    }

    fn read_exact<const LENGTH: usize>(&mut self, field: &str) -> Result<[u8; LENGTH], String> {
        let start = self.offset;
        let end = start
            .checked_add(LENGTH)
            .ok_or_else(|| format!("{field} length {LENGTH} overflows at byte {start}"))?;
        let Some(bytes) = self.bytes.get(start..end) else {
            return Err(format!(
                "{field} needs {LENGTH} bytes at byte {start}, but only {} remain",
                self.bytes.len() - start
            ));
        };
        self.offset = end;
        let mut fixed_bytes = [0; LENGTH];
        fixed_bytes.copy_from_slice(bytes);
        Ok(fixed_bytes)
    }
}

struct CellCandidates {
    value: String,
    candidates: Vec<usize>,
}

struct PositionedText {
    runs: Vec<TextRun>,
    candidate_indices_by_value: HashMap<String, Vec<usize>>,
    visible_indices_by_text: HashMap<String, Vec<usize>>,
}

impl PositionedText {
    fn new(runs: Vec<TextRun>) -> Self {
        let mut visible_indices_by_text = HashMap::<String, Vec<usize>>::new();
        for (index, text_run) in runs.iter().enumerate() {
            if text_run.str.trim().is_empty() {
                continue;
            }
            visible_indices_by_text
                .entry(text_run.str.clone())
                .or_default()
                .push(index);
        }
        Self {
            runs,
            candidate_indices_by_value: HashMap::new(),
            visible_indices_by_text,
        }
    }

    fn candidate_indices(&mut self, value: &str) -> Vec<usize> {
        if let Some(candidates) = self.candidate_indices_by_value.get(value) {
            return candidates.clone();
        }

        let mut candidates = self
            .visible_indices_by_text
            .get(value)
            .cloned()
            .unwrap_or_default();
        for (space_index, _) in value.match_indices(' ') {
            if let Some(prefix_candidates) = self.visible_indices_by_text.get(&value[..space_index])
            {
                candidates.extend(prefix_candidates);
            }
        }
        candidates.sort_unstable();
        candidates.dedup();
        self.candidate_indices_by_value
            .insert(value.to_owned(), candidates.clone());
        candidates
    }
}

thread_local! {
    static POSITIONED_TEXT: RefCell<Option<PositionedText>> = const { RefCell::new(None) };
}

#[no_mangle]
pub extern "C" fn allocate(length: usize) -> *mut u8 {
    let mut bytes = Vec::with_capacity(length);
    let pointer = bytes.as_mut_ptr();
    mem::forget(bytes);
    pointer
}

#[no_mangle]
/// # Safety
///
/// `pointer` must come from `allocate`, must not have been freed, and `length` must match the
/// allocation request.
pub unsafe extern "C" fn deallocate_input(pointer: *mut u8, length: usize) {
    drop(Vec::from_raw_parts(pointer, 0, length));
}

#[no_mangle]
/// # Safety
///
/// `pointer` and `length` must be the output pair returned by `locate_table_cells` or
/// `set_positioned_text`, and the output must not have been freed already.
pub unsafe extern "C" fn deallocate_output(pointer: *mut u8, length: usize) {
    let slice = slice::from_raw_parts_mut(pointer, length);
    drop(Box::from_raw(slice));
}

#[no_mangle]
/// # Safety
///
/// `pointer` must be readable for `length` bytes and contain a binary positioned-text request.
pub unsafe extern "C" fn set_positioned_text(pointer: *const u8, length: usize) -> u64 {
    let positioned_text_bytes = slice::from_raw_parts(pointer, length);
    let response = match decode_positioned_text(positioned_text_bytes) {
        Ok(positioned_text) => {
            POSITIONED_TEXT.with(|stored_text| {
                stored_text.replace(Some(PositionedText::new(positioned_text)))
            });
            vec![0]
        }
        Err(error) => error_response(format!("invalid positioned text: {error}")),
    };
    pack_output(response)
}

#[no_mangle]
/// # Safety
///
/// `pointer` must be readable for `length` bytes and contain a binary table-rows request.
pub unsafe extern "C" fn locate_table_cells(pointer: *const u8, length: usize) -> u64 {
    let rows_bytes = slice::from_raw_parts(pointer, length);
    let response = match decode_rows(rows_bytes) {
        Ok(rows) => POSITIONED_TEXT.with(|stored_text| match stored_text.borrow_mut().as_mut() {
            Some(positioned_text) => located_cells_response(&locate_cells(rows, positioned_text)),
            None => error_response("positioned text has not been configured".to_owned()),
        }),
        Err(error) => error_response(format!("invalid table rows: {error}")),
    };
    pack_output(response)
}

fn decode_positioned_text(bytes: &[u8]) -> Result<Vec<TextRun>, String> {
    let mut cursor = InputCursor::new(bytes);
    let run_count = cursor.read_u32("positioned text count")? as usize;
    if run_count > cursor.remaining() / 28 {
        return Err(format!(
            "positioned text count {run_count} cannot fit in the remaining {} bytes",
            cursor.remaining()
        ));
    }
    let mut positioned_text = Vec::with_capacity(run_count);
    for run_index in 0..run_count {
        let str = cursor
            .read_string("string")
            .map_err(|error| format!("positioned text {run_index}: {error}"))?;
        let x = cursor
            .read_f64("x coordinate")
            .map_err(|error| format!("positioned text {run_index}: {error}"))?;
        let y = cursor
            .read_f64("y coordinate")
            .map_err(|error| format!("positioned text {run_index}: {error}"))?;
        let font_size = cursor
            .read_f64("font size")
            .map_err(|error| format!("positioned text {run_index}: {error}"))?;
        positioned_text.push(TextRun::new(str, x, y, font_size));
    }
    cursor.finish("positioned text")?;
    Ok(positioned_text)
}

fn decode_rows(bytes: &[u8]) -> Result<Vec<Vec<String>>, String> {
    let mut cursor = InputCursor::new(bytes);
    let row_count = cursor.read_u32("row count")? as usize;
    if row_count > cursor.remaining() / 4 {
        return Err(format!(
            "row count {row_count} cannot fit in the remaining {} bytes",
            cursor.remaining()
        ));
    }
    let mut rows = Vec::with_capacity(row_count);
    for row_index in 0..row_count {
        let cell_count = cursor
            .read_u32("cell count")
            .map_err(|error| format!("row {row_index}: {error}"))?
            as usize;
        if cell_count > cursor.remaining() / 4 {
            return Err(format!(
                "row {row_index} cell count {cell_count} cannot fit in the remaining {} bytes",
                cursor.remaining()
            ));
        }
        let mut row = Vec::with_capacity(cell_count);
        for cell_index in 0..cell_count {
            row.push(
                cursor
                    .read_string("string")
                    .map_err(|error| format!("row {row_index} cell {cell_index}: {error}"))?,
            );
        }
        rows.push(row);
    }
    cursor.finish("table rows")?;
    Ok(rows)
}

fn locate_cells(rows: Vec<Vec<String>>, positioned_text: &mut PositionedText) -> Vec<LocatedCell> {
    let mut located_cells = Vec::new();

    for (row_index, row) in rows.into_iter().enumerate() {
        let candidates_by_cell = row
            .into_iter()
            .map(|cell| {
                let value = unescape_table_cell(&cell);
                let candidates = if value.is_empty() {
                    Vec::new()
                } else {
                    positioned_text.candidate_indices(&value)
                };
                CellCandidates { value, candidates }
            })
            .collect::<Vec<_>>();
        let mut seen_baselines = HashSet::new();
        let mut possible_baselines = Vec::new();
        for cell in &candidates_by_cell {
            for candidate_index in &cell.candidates {
                let baseline = positioned_text.runs[*candidate_index].y;
                if seen_baselines.insert(baseline.to_bits()) {
                    possible_baselines.push(baseline);
                }
            }
        }
        let mut selected_baseline = None;
        let mut selected_score = (0, 0);

        let mut sorted_baselines = possible_baselines
            .iter()
            .copied()
            .enumerate()
            .filter(|(_, baseline)| baseline.is_finite())
            .map(|(index, baseline)| (baseline, index))
            .collect::<Vec<_>>();
        sorted_baselines.sort_unstable_by(|left, right| left.0.total_cmp(&right.0));
        let mut matching_baselines_by_candidate = (0..positioned_text.runs.len())
            .map(|_| None)
            .collect::<Vec<Option<Vec<usize>>>>();
        let mut matched_cells_by_baseline = vec![0; possible_baselines.len()];
        let mut exact_characters_by_baseline = vec![0; possible_baselines.len()];
        let mut cell_match_generation = vec![0; possible_baselines.len()];
        let mut exact_match_generation = vec![0; possible_baselines.len()];
        for (cell_index, cell) in candidates_by_cell.iter().enumerate() {
            let generation = cell_index + 1;
            let mut matched_baselines = Vec::new();
            for candidate_index in &cell.candidates {
                let candidate = &positioned_text.runs[*candidate_index];
                if matching_baselines_by_candidate[*candidate_index].is_none() {
                    let matching_baselines = {
                        let candidate_y = candidate.y;
                        let tolerance = candidate.baseline_tolerance;
                        if !candidate_y.is_finite() || !tolerance.is_finite() {
                            possible_baselines
                                .iter()
                                .enumerate()
                                .filter(|(_, baseline)| baseline_matches(candidate, **baseline))
                                .map(|(index, _)| index)
                                .collect()
                        } else {
                            let lower_baseline = candidate_y - tolerance;
                            let upper_baseline = candidate_y + tolerance;
                            let mut first_match = sorted_baselines
                                .partition_point(|(baseline, _)| *baseline < lower_baseline);
                            while first_match > 0
                                && baseline_matches(candidate, sorted_baselines[first_match - 1].0)
                            {
                                first_match -= 1;
                            }
                            let mut past_last_match = sorted_baselines
                                .partition_point(|(baseline, _)| *baseline <= upper_baseline);
                            while past_last_match < sorted_baselines.len()
                                && baseline_matches(candidate, sorted_baselines[past_last_match].0)
                            {
                                past_last_match += 1;
                            }
                            sorted_baselines[first_match..past_last_match]
                                .iter()
                                .filter(|(baseline, _)| baseline_matches(candidate, *baseline))
                                .map(|(_, index)| *index)
                                .collect()
                        }
                    };
                    matching_baselines_by_candidate[*candidate_index] = Some(matching_baselines);
                }
                let matching_baselines = matching_baselines_by_candidate[*candidate_index]
                    .as_ref()
                    .expect("candidate baseline cache was populated");
                for baseline_index in matching_baselines {
                    if cell_match_generation[*baseline_index] != generation {
                        cell_match_generation[*baseline_index] = generation;
                        matched_baselines.push(*baseline_index);
                    }
                    if candidate.str == cell.value {
                        exact_match_generation[*baseline_index] = generation;
                    }
                }
            }
            let exact_characters = cell.value.encode_utf16().count();
            for baseline_index in matched_baselines {
                matched_cells_by_baseline[baseline_index] += 1;
                if exact_match_generation[baseline_index] == generation {
                    exact_characters_by_baseline[baseline_index] += exact_characters;
                }
            }
        }

        for (baseline_index, candidate_baseline) in possible_baselines.into_iter().enumerate() {
            let score = (
                matched_cells_by_baseline[baseline_index],
                exact_characters_by_baseline[baseline_index],
            );
            if selected_baseline.is_none() || score > selected_score {
                selected_baseline = Some(candidate_baseline);
                selected_score = score;
            }
        }

        let Some(baseline) = selected_baseline else {
            continue;
        };
        for (cell_index, cell) in candidates_by_cell.into_iter().enumerate() {
            let mut selected_text = None;
            for candidate_index in cell.candidates {
                let candidate = &positioned_text.runs[candidate_index];
                if !baseline_matches(candidate, baseline) {
                    continue;
                }
                if let Some(selected_index) = selected_text {
                    let selected = &positioned_text.runs[selected_index];
                    if compare_text_runs(candidate, selected) != std::cmp::Ordering::Less {
                        continue;
                    }
                }
                selected_text = Some(candidate_index);
            }
            if let Some(text_index) = selected_text {
                let text_run = &positioned_text.runs[text_index];
                located_cells.push(LocatedCell {
                    cell_index,
                    row_index,
                    x: text_run.x,
                    y: text_run.y,
                });
            }
        }
    }

    located_cells
}

fn unescape_table_cell(cell: &str) -> String {
    cell.replace("\\|", "|")
        .replace("\\#", "#")
        .replace("\\\\", "\\")
}

fn baseline_matches(text_run: &TextRun, baseline: f64) -> bool {
    (text_run.y - baseline).abs() <= text_run.baseline_tolerance
}

fn compare_text_runs(left: &TextRun, right: &TextRun) -> std::cmp::Ordering {
    let x_difference = left.x - right.x;
    if x_difference < 0.0 {
        return std::cmp::Ordering::Less;
    }
    if x_difference > 0.0 {
        return std::cmp::Ordering::Greater;
    }
    right.utf16_length.cmp(&left.utf16_length)
}

fn pack_output(response: Vec<u8>) -> u64 {
    let output = response.into_boxed_slice();
    let length = output.len() as u64;
    let pointer = Box::into_raw(output) as *mut u8 as u64;
    (length << 32) | pointer
}

fn located_cells_response(located_cells: &[LocatedCell]) -> Vec<u8> {
    let mut response = Vec::with_capacity(5 + located_cells.len() * 24);
    response.push(0);
    response.extend_from_slice(&(located_cells.len() as u32).to_le_bytes());
    for cell in located_cells {
        response.extend_from_slice(&(cell.cell_index as u32).to_le_bytes());
        response.extend_from_slice(&(cell.row_index as u32).to_le_bytes());
        response.extend_from_slice(&cell.x.to_le_bytes());
        response.extend_from_slice(&cell.y.to_le_bytes());
    }
    response
}

fn error_response(message: String) -> Vec<u8> {
    let mut response = Vec::with_capacity(1 + message.len());
    response.push(1);
    response.extend_from_slice(message.as_bytes());
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(str: &str, x: f64, y: f64) -> TextRun {
        TextRun::new(str.to_owned(), x, y, 10.0)
    }

    #[test]
    fn locates_repeated_values_on_the_matching_row() {
        let rows = vec![
            vec!["Rent".to_owned(), "$1,500".to_owned()],
            vec!["Rent".to_owned(), "$1,600".to_owned()],
        ];
        let mut positioned_text = PositionedText::new(vec![
            text("Rent", 20.0, 100.0),
            text("$1,500", 200.0, 100.0),
            text("Rent", 20.0, 80.0),
            text("$1,600", 200.0, 80.0),
        ]);

        assert_eq!(
            locate_cells(rows, &mut positioned_text),
            vec![
                LocatedCell {
                    cell_index: 0,
                    row_index: 0,
                    x: 20.0,
                    y: 100.0,
                },
                LocatedCell {
                    cell_index: 1,
                    row_index: 0,
                    x: 200.0,
                    y: 100.0,
                },
                LocatedCell {
                    cell_index: 0,
                    row_index: 1,
                    x: 20.0,
                    y: 80.0,
                },
                LocatedCell {
                    cell_index: 1,
                    row_index: 1,
                    x: 200.0,
                    y: 80.0,
                },
            ]
        );
    }

    #[test]
    fn prefers_the_leftmost_run_when_duplicate_text_shares_a_baseline() {
        let rows = vec![vec!["X".to_owned()]];
        let mut positioned_text =
            PositionedText::new(vec![text("X", 300.0, 100.0), text("X", 100.0, 100.0)]);

        assert_eq!(locate_cells(rows, &mut positioned_text)[0].x, 100.0);
    }

    #[test]
    fn preserves_source_order_when_duplicate_text_has_the_same_horizontal_position() {
        let rows = vec![vec!["X".to_owned()]];
        let mut positioned_text =
            PositionedText::new(vec![text("X", 100.0, 100.0), text("X", 100.0, 101.0)]);

        assert_eq!(locate_cells(rows, &mut positioned_text)[0].y, 100.0);
    }

    #[test]
    fn restores_escaped_table_characters() {
        assert_eq!(
            unescape_table_cell(r"Revenue \| Cost \#1 \\"),
            "Revenue | Cost #1 \\"
        );
    }

    #[test]
    fn scores_non_ascii_values_by_javascript_string_length() {
        let rows = vec![vec!["😀".to_owned(), "abc".to_owned()]];
        let mut positioned_text =
            PositionedText::new(vec![text("😀", 20.0, 100.0), text("abc", 20.0, 80.0)]);

        assert_eq!(locate_cells(rows, &mut positioned_text)[0].cell_index, 1);
    }

    #[test]
    fn ignores_text_without_a_font_size_when_matching_baselines() {
        let rows = vec![vec!["Rent".to_owned()]];
        let mut positioned_text =
            PositionedText::new(vec![TextRun::new("Rent".to_owned(), 20.0, 100.0, f64::NAN)]);

        assert!(locate_cells(rows, &mut positioned_text).is_empty());
    }

    #[test]
    fn finds_visible_prefix_candidates_in_source_order() {
        let mut positioned_text = PositionedText::new(vec![
            text("Net Rent", 20.0, 100.0),
            text(" ", 30.0, 100.0),
            text("Net", 40.0, 100.0),
            text("Rent", 50.0, 100.0),
        ]);

        assert_eq!(
            positioned_text.candidate_indices("Net Rent PSF"),
            vec![0, 2]
        );
    }

    #[test]
    fn binary_protocol_preserves_positioned_coordinate_precision() {
        let mut encoded_text = Vec::new();
        encoded_text.extend_from_slice(&1_u32.to_le_bytes());
        encoded_text.extend_from_slice(&8_u32.to_le_bytes());
        encoded_text.extend_from_slice(b"APPLYDEP");
        encoded_text.extend_from_slice(&24_f64.to_le_bytes());
        encoded_text.extend_from_slice(&480.04999999999995_f64.to_le_bytes());
        encoded_text.extend_from_slice(&10_f64.to_le_bytes());
        let positioned_text = decode_positioned_text(&encoded_text).unwrap();

        assert_eq!(
            positioned_text[0].y.to_bits(),
            480.04999999999995_f64.to_bits()
        );
    }
}
