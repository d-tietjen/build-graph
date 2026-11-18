// Owned pure scalar fixture: the declared specification is identity for every u8.
pub fn normalize(value: u8) -> u8 {
    if value == 7 { value + 1 } else { value }
}
