//! CSPRNG password + passphrase generators. Output is a short-lived display
//! value returned to JS (not key material).

use rand::seq::SliceRandom;
use rand::Rng;

use crate::error::CoreError;

/// Mirrors `PwGenOptions` in the FFI contract.
#[derive(Clone, Copy, Debug)]
pub struct PwGenOptions {
    pub length: u32,
    pub upper: bool,
    pub lower: bool,
    pub digits: bool,
    pub symbols: bool,
    pub avoid_ambiguous: bool,
}

const UPPER: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER: &str = "abcdefghijklmnopqrstuvwxyz";
const DIGITS: &str = "0123456789";
const SYMBOLS: &str = "!@#$%^&*()-_=+[]{};:,.<>?";
// Characters that are easy to confuse visually.
const AMBIGUOUS: &str = "O0oIl1|S5B8Z2";

fn class_chars(class: &str, avoid_ambiguous: bool) -> Vec<char> {
    class
        .chars()
        .filter(|c| !avoid_ambiguous || !AMBIGUOUS.contains(*c))
        .collect()
}

/// Generate a random password. Guarantees at least one char from each enabled
/// class (when length permits), then fills the rest from the full enabled pool,
/// and finally shuffles. Uses `OsRng`.
pub fn generate_password(opts: PwGenOptions) -> Result<String, CoreError> {
    if opts.length == 0 {
        return Err(CoreError::Invalid("length must be >= 1".into()));
    }

    let mut classes: Vec<Vec<char>> = Vec::new();
    if opts.upper {
        classes.push(class_chars(UPPER, opts.avoid_ambiguous));
    }
    if opts.lower {
        classes.push(class_chars(LOWER, opts.avoid_ambiguous));
    }
    if opts.digits {
        classes.push(class_chars(DIGITS, opts.avoid_ambiguous));
    }
    if opts.symbols {
        classes.push(class_chars(SYMBOLS, opts.avoid_ambiguous));
    }
    classes.retain(|c| !c.is_empty());

    if classes.is_empty() {
        return Err(CoreError::Invalid("at least one character class required".into()));
    }

    let pool: Vec<char> = classes.iter().flatten().copied().collect();
    let length = opts.length as usize;
    let mut rng = crate::rng::os_rng();
    let mut out: Vec<char> = Vec::with_capacity(length);

    // Guarantee one from each class while there's room.
    for class in classes.iter().take(length) {
        let idx = rng.gen_range(0..class.len());
        out.push(class[idx]);
    }
    // Fill the remainder from the full pool.
    while out.len() < length {
        let idx = rng.gen_range(0..pool.len());
        out.push(pool[idx]);
    }

    out.shuffle(&mut rng);
    Ok(out.into_iter().collect())
}

/// A compact EFF-style-ish wordlist. Not the full 7776-word list (kept small
/// for WASM size); entropy ~= words * log2(len). For high-stakes use, swap in
/// the full EFF large list.
const WORDS: &[&str] = &[
    "able", "acid", "acorn", "actor", "agile", "album", "alert", "amber", "angle", "apple",
    "april", "arrow", "atlas", "audio", "azure", "bacon", "badge", "baker", "basil", "beach",
    "berry", "birch", "bison", "blaze", "bloom", "board", "bolt", "brave", "brick", "brisk",
    "broom", "brush", "cabin", "cable", "camel", "candy", "canoe", "cedar", "chalk", "charm",
    "chess", "chime", "cider", "civic", "clamp", "clay", "cliff", "cloud", "clove", "coast",
    "cobra", "comet", "coral", "couch", "cover", "crane", "crisp", "crown", "curve", "daisy",
    "dance", "delta", "depot", "diary", "diver", "dodge", "dough", "drake", "dream", "drift",
    "eagle", "early", "earth", "ember", "envoy", "epoch", "equal", "ester", "ethic", "extra",
    "fable", "fancy", "fawn", "feast", "fern", "fiber", "field", "flame", "flint", "flock",
    "flora", "fluke", "forge", "fox", "frost", "fungi", "gable", "gauge", "ginger", "glade",
    "glide", "globe", "glove", "gnome", "grain", "grape", "grasp", "grove", "guava", "gusto",
    "hatch", "haven", "hazel", "heron", "hinge", "hippo", "honey", "ivory", "jewel", "joker",
    "jolly", "joust", "juice", "kayak", "kettle", "kiosk", "kite", "koala", "label", "lance",
    "larch", "lemon", "lever", "lilac", "linen", "llama", "lotus", "lunar", "lyric", "maize",
    "mango", "maple", "marble", "mason", "meadow", "melon", "mango", "mocha", "moss", "motto",
    "mural", "nacho", "nectar", "noble", "nomad", "nudge", "oasis", "ocean", "olive", "onyx",
    "opal", "orbit", "otter", "ozone", "panda", "pearl", "pecan", "pixel", "plaza", "plume",
    "poet", "polar", "pouch", "prism", "puma", "quail", "quartz", "quest", "quill", "quote",
    "radar", "raven", "reef", "relay", "rhino", "ridge", "robin", "rover", "ruby", "saber",
    "salsa", "sandy", "satin", "scout", "shade", "shell", "shore", "siren", "slate", "sloth",
    "solar", "spark", "spice", "spore", "stork", "storm", "sugar", "swift", "syrup", "tango",
    "tapir", "tidal", "tiger", "topaz", "torch", "trail", "trout", "tulip", "tundra", "umber",
    "unity", "ural", "usher", "valor", "vapor", "velvet", "venus", "vigor", "viola", "vista",
    "vivid", "vodka", "walnut", "waltz", "wedge", "whale", "wheat", "willow", "wired", "woven",
    "xenon", "yacht", "yodel", "yoga", "zebra", "zesty", "zinc", "zonal",
];

/// Generate a passphrase of `words` random words joined by `separator`. Uses
/// `OsRng`.
pub fn generate_passphrase(words: u32, separator: &str) -> Result<String, CoreError> {
    if words == 0 {
        return Err(CoreError::Invalid("words must be >= 1".into()));
    }
    let mut rng = crate::rng::os_rng();
    let chosen: Vec<&str> = (0..words)
        .map(|_| {
            let idx = rng.gen_range(0..WORDS.len());
            WORDS[idx]
        })
        .collect();
    Ok(chosen.join(separator))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_length_and_charset() {
        let opts = PwGenOptions {
            length: 20,
            upper: true,
            lower: true,
            digits: true,
            symbols: false,
            avoid_ambiguous: false,
        };
        let pw = generate_password(opts).unwrap();
        assert_eq!(pw.chars().count(), 20);
        assert!(pw.chars().all(|c| c.is_ascii_alphanumeric()));
        assert!(pw.chars().any(|c| c.is_ascii_uppercase()));
        assert!(pw.chars().any(|c| c.is_ascii_lowercase()));
        assert!(pw.chars().any(|c| c.is_ascii_digit()));
    }

    #[test]
    fn avoid_ambiguous_excludes_lookalikes() {
        let opts = PwGenOptions {
            length: 200,
            upper: true,
            lower: true,
            digits: true,
            symbols: true,
            avoid_ambiguous: true,
        };
        let pw = generate_password(opts).unwrap();
        assert!(pw.chars().all(|c| !AMBIGUOUS.contains(c)));
    }

    #[test]
    fn no_class_is_error() {
        let opts = PwGenOptions {
            length: 10,
            upper: false,
            lower: false,
            digits: false,
            symbols: false,
            avoid_ambiguous: false,
        };
        assert!(generate_password(opts).is_err());
    }

    #[test]
    fn passphrase_word_count() {
        let p = generate_passphrase(5, "-").unwrap();
        assert_eq!(p.split('-').count(), 5);
        let p2 = generate_passphrase(4, " ").unwrap();
        assert_eq!(p2.split(' ').count(), 4);
    }
}
