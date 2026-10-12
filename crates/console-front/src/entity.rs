//! Links between sections.
//!
//! A section's payload that points at something another section shows
//! carries an [`EntityRef`], which the console turns into a link through the
//! target section's registry. The type and its constructors live in
//! `firenook-suite-front`, where every log producer reaches them (a log
//! line carries refs too); this module is the console's name for them, so
//! sections build keys through `crate::entity::EntityRef` as before.

pub use firenook_suite_front::entity::EntityRef;
