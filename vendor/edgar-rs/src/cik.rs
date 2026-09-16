use std::fmt;

use serde::{Deserialize, Serialize};

/// A Central Index Key (CIK) number identifying a company in SEC EDGAR.
///
/// CIK numbers are zero-padded to 10 digits in SEC URLs (e.g., `CIK0000320193`).
/// This type handles formatting automatically.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Cik(u64);

impl Cik {
    /// Creates a new CIK from a numeric value.
    pub fn new(value: u64) -> Self {
        Self(value)
    }

    /// Returns the raw numeric value.
    pub fn as_u64(self) -> u64 {
        self.0
    }

    /// Formats the CIK as a zero-padded 10-digit string (e.g., `"0000320193"`).
    pub fn to_padded_string(self) -> String {
        format!("{:010}", self.0)
    }
}

impl fmt::Display for Cik {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<u64> for Cik {
    fn from(value: u64) -> Self {
        Self(value)
    }
}

impl From<u32> for Cik {
    fn from(value: u32) -> Self {
        Self(value as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_and_as_u64() {
        let cik = Cik::new(320193);
        assert_eq!(cik.as_u64(), 320193);
    }

    #[test]
    fn to_padded_string_normal() {
        assert_eq!(Cik::new(320193).to_padded_string(), "0000320193");
    }

    #[test]
    fn to_padded_string_small() {
        assert_eq!(Cik::new(1).to_padded_string(), "0000000001");
    }

    #[test]
    fn to_padded_string_large() {
        assert_eq!(Cik::new(1234567890).to_padded_string(), "1234567890");
    }

    #[test]
    fn to_padded_string_zero() {
        assert_eq!(Cik::new(0).to_padded_string(), "0000000000");
    }

    #[test]
    fn display_shows_raw_number() {
        assert_eq!(format!("{}", Cik::new(320193)), "320193");
        assert_eq!(format!("{}", Cik::new(0)), "0");
    }

    #[test]
    fn from_u64() {
        let cik: Cik = 320193_u64.into();
        assert_eq!(cik.as_u64(), 320193);
    }

    #[test]
    fn from_u32() {
        let cik: Cik = 320193_u32.into();
        assert_eq!(cik.as_u64(), 320193);
    }

    #[test]
    fn equality() {
        assert_eq!(Cik::new(100), Cik::new(100));
        assert_ne!(Cik::new(100), Cik::new(200));
    }

    #[test]
    fn hash_consistent() {
        use std::collections::HashSet;
        let mut set = HashSet::new();
        set.insert(Cik::new(320193));
        assert!(set.contains(&Cik::new(320193)));
        assert!(!set.contains(&Cik::new(1)));
    }

    #[test]
    fn clone_and_copy() {
        let a = Cik::new(42);
        let b = a; // Copy
        let c = a; // Also Copy
        assert_eq!(a, b);
        assert_eq!(a, c);
    }

    #[test]
    fn serde_roundtrip() {
        let cik = Cik::new(320193);
        let json = serde_json::to_string(&cik).unwrap();
        assert_eq!(json, "320193");
        let deserialized: Cik = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized, cik);
    }

    #[test]
    fn serde_transparent_in_struct() {
        #[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
        struct Wrapper {
            cik: Cik,
        }
        let w = Wrapper {
            cik: Cik::new(320193),
        };
        let json = serde_json::to_string(&w).unwrap();
        assert_eq!(json, r#"{"cik":320193}"#);
        let back: Wrapper = serde_json::from_str(&json).unwrap();
        assert_eq!(back, w);
    }
}
