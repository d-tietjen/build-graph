//! Independent capture controls. These are not model relevance inputs.
/// Module-owned effective docs.
pub mod layer {
    /// Trait identity remains distinct from its implementations.
    pub trait T {
        /// This contract belongs to the original trait method.
        fn p(&self);
        /// Associated type documentation.
        type Output;
    }
    /// A named type with a documented field.
    pub struct A {
        /// The original field owns this documentation.
        pub channel: u8,
    }
    /// Tuple ordinals include a hidden slot.
    pub struct B(
        /// First ordinal.
        pub u8,
        #[doc(hidden)] pub u8,
        /// Third ordinal.
        pub u8,
    );
    /// Variants and their tuple fields retain distinct occurrences.
    pub enum E {
        /// Original named variant.
        First {
            /// Original named variant field.
            value: u8,
        },
        /// Original tuple variant.
        Second(/// Original tuple field.
            u8),
    }
    impl T for A {
        /// This text belongs to A's implementation, not the trait declaration.
        fn p(&self) {
            // Exact supported method body intent.
            let _ = self.channel;
        }
        type Output = u8;
    }
    impl T for B {
        /// Same method name; a different original implementation occurrence.
        fn p(&self) {
            /* Another exact supported method body. */
        }
        type Output = u16;
    }
    /// Same normalized graph spelling as the next declaration.
    pub fn Run() {}
    /// A separate original occurrence despite normalized name collision.
    pub fn run() {}
    pub mod nested {
        /// Nested same-spelling declaration.
        pub fn run() {}
    }
}
/// Unicode names/columns do not use UTF-8 byte counts as compiler columns.
pub fn café() {
    let _literal = r###"// not a comment /* not a comment */"###;
    let _character = '/';
    // Unicode body intent: café 🦀.
    /* Nested body intent /* internal */ remains one exact token. */
}
/// A const-generic signature is deliberately unsupported for body ownership.
pub fn generic<const N: usize>() {
    // Retain at file level; do not infer a body through const signature braces.
}
/// Nested unsupported item regions do not inherit an outer body owner.
pub fn outer() {
    fn nested() {
        // Retain at file level because the enclosing original body is uncertain.
    }
    nested();
}
macro_rules! make_item {
    () => {
        /// Effective generated documentation, with expanded source uncertainty.
        pub fn generated() {
            // Macro-origin body text is not attached through a callsite span.
        }
    };
}
make_item!();
#[doc = include_str!("included.md")]
pub fn bundled() {}
#[cfg(any())]
/// Not present in this configured compiler export.
pub fn disabled() {
    // Exact local text can remain file evidence, with no exported symbol owner.
}
#[cfg_attr(feature = "blue", doc = "Blue configuration documentation.")]
#[cfg_attr(not(feature = "blue"), doc = "Default configuration documentation.")]
pub fn configuration() {}
fn main() {}
