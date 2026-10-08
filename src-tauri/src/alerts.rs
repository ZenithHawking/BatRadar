//! Which usage alert to fire. Firing a level also marks every lower level as
//! fired, so 100% → "Limit" is never followed by "Critical" then "Warning".

#[derive(Default, Clone, Copy, Debug, PartialEq)]
pub struct AlertFlags {
    pub warn: bool,
    pub crit: bool,
    pub limit: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Level {
    Warning,
    Critical,
    Limit,
}

pub fn pick(util: f64, warn_th: f64, crit_th: f64, f: &mut AlertFlags) -> Option<Level> {
    if util >= 1.0 && !f.limit {
        *f = AlertFlags { warn: true, crit: true, limit: true };
        Some(Level::Limit)
    } else if util >= crit_th && !f.crit {
        f.warn = true;
        f.crit = true;
        Some(Level::Critical)
    } else if util >= warn_th && !f.warn {
        f.warn = true;
        Some(Level::Warning)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jump_to_full_fires_limit_once_then_nothing() {
        let mut f = AlertFlags::default();
        assert_eq!(pick(1.0, 0.8, 0.95, &mut f), Some(Level::Limit));
        assert_eq!(pick(1.0, 0.8, 0.95, &mut f), None);
        assert_eq!(pick(1.0, 0.8, 0.95, &mut f), None);
    }

    #[test]
    fn climbing_fires_each_level_once() {
        let mut f = AlertFlags::default();
        assert_eq!(pick(0.5, 0.8, 0.95, &mut f), None);
        assert_eq!(pick(0.85, 0.8, 0.95, &mut f), Some(Level::Warning));
        assert_eq!(pick(0.9, 0.8, 0.95, &mut f), None);
        assert_eq!(pick(0.96, 0.8, 0.95, &mut f), Some(Level::Critical));
        assert_eq!(pick(1.0, 0.8, 0.95, &mut f), Some(Level::Limit));
        assert_eq!(pick(1.0, 0.8, 0.95, &mut f), None);
    }

    #[test]
    fn critical_jump_suppresses_later_warning() {
        let mut f = AlertFlags::default();
        assert_eq!(pick(0.97, 0.8, 0.95, &mut f), Some(Level::Critical));
        assert_eq!(pick(0.85, 0.8, 0.95, &mut f), None);
    }
}
