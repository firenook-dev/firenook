use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};

use serde::Deserialize;

use crate::query::{Direction, FieldOperator, Filter, Query, QueryScope as StructuredQueryScope};

/// The field every Firestore index ends with, implicitly.
const DOCUMENT_NAME: &str = "__name__";

/// Index query scope used by `firestore.indexes.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum IndexScope {
    Collection,
    CollectionGroup,
}

/// Ordered index direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum IndexDirection {
    Ascending,
    Descending,
}

/// Index mode required for one field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum IndexMode {
    Ordered(IndexDirection),
    ArrayContains,
    Vector(usize),
}

/// One field in a missing index requirement.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct IndexRequirementField {
    pub field_path: String,
    pub mode: IndexMode,
}

/// A production-style index requirement derived from a structured query.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct IndexRequirement {
    pub collection_group: String,
    pub query_scope: IndexScope,
    pub fields: Vec<IndexRequirementField>,
}

impl IndexRequirement {
    /// Whether this spans more than one field, which is what production
    /// calls a composite index and never creates on its own.
    #[must_use]
    pub fn is_composite(&self) -> bool {
        self.fields.len() > 1
    }

    /// The entry to paste into `firestore.indexes.json`, in the format the
    /// Firebase CLI reads and writes.
    #[must_use]
    pub fn config_entry(&self) -> serde_json::Value {
        serde_json::json!({
            "collectionGroup": self.collection_group,
            "queryScope": match self.query_scope {
                IndexScope::Collection => "COLLECTION",
                IndexScope::CollectionGroup => "COLLECTION_GROUP",
            },
            "fields": self.fields.iter().map(IndexRequirementField::config_entry).collect::<Vec<_>>(),
        })
    }

    /// Where this belongs in `firestore.indexes.json`, and the entry to add:
    /// a composite index under `indexes`, or, for one field, a field override
    /// under `fieldOverrides`. An override replaces the field's automatic
    /// indexes, so the entry keeps them beside the one required.
    #[must_use]
    pub fn declaration(&self) -> (&'static str, serde_json::Value) {
        self.declaration_in(&IndexCatalog::default())
    }

    /// [`Self::declaration`] for the file `catalog` was read from: a field
    /// that already has an override there keeps it, with the index required
    /// added, since a second override for one field is not a valid file.
    #[must_use]
    pub fn declaration_in(&self, catalog: &IndexCatalog) -> (&'static str, serde_json::Value) {
        let [field] = self.fields.as_slice() else {
            return ("indexes", self.config_entry());
        };
        let required = SingleFieldIndex {
            scope: self.query_scope,
            mode: field.mode,
        };
        let existing = catalog.field_overrides.iter().find(|override_| {
            override_.collection_group == self.collection_group
                && override_.field_path == field.field_path
        });
        let mut indexes = match existing {
            Some(existing) => existing.indexes.iter().copied().collect::<Vec<_>>(),
            None => [
                IndexMode::Ordered(IndexDirection::Ascending),
                IndexMode::Ordered(IndexDirection::Descending),
                IndexMode::ArrayContains,
            ]
            .map(|mode| SingleFieldIndex {
                scope: IndexScope::Collection,
                mode,
            })
            .to_vec(),
        };
        if !indexes.contains(&required) {
            indexes.push(required);
        }
        (
            "fieldOverrides",
            serde_json::json!({
                "collectionGroup": self.collection_group,
                "fieldPath": field.field_path,
                "indexes": indexes.iter().map(SingleFieldIndex::config_entry).collect::<Vec<_>>(),
            }),
        )
    }

    /// Reads one entry of the file's `indexes`.
    pub fn from_entry(entry: &serde_json::Value) -> Result<Self, IndexConfigError> {
        RawIndex::deserialize(entry)
            .map_err(|error| IndexConfigError::InvalidDefinition(error.to_string()))
            .and_then(Self::try_from)
    }

    /// What a developer is told of a query that needs this index: what is
    /// missing, and the entry to copy into `firestore.indexes.json`.
    #[must_use]
    pub fn missing_message(&self) -> String {
        let (list, entry) = self.declaration();
        let entry = serde_json::to_string_pretty(&entry).unwrap_or_else(|_| entry.to_string());
        let (kind, scope) = match (self.is_composite(), self.query_scope) {
            (true, _) => ("a composite index", ""),
            (false, IndexScope::CollectionGroup) => {
                ("a single-field index", " for collection group queries")
            }
            (false, IndexScope::Collection) => ("a single-field index", ""),
        };
        format!(
            "The query requires {kind} on \"{}\"{scope} that firestore.indexes.json does not declare. Add to its \"{list}\":\n{entry}",
            self.collection_group
        )
    }
}

/// A field's index mode as `firestore.indexes.json` spells it, without the
/// field path.
fn field_mode_entry(mode: IndexMode) -> serde_json::Value {
    match mode {
        IndexMode::Ordered(IndexDirection::Ascending) => serde_json::json!({"order": "ASCENDING"}),
        IndexMode::Ordered(IndexDirection::Descending) => {
            serde_json::json!({"order": "DESCENDING"})
        }
        IndexMode::ArrayContains => serde_json::json!({"arrayConfig": "CONTAINS"}),
        IndexMode::Vector(dimension) => {
            serde_json::json!({"vectorConfig": {"dimension": dimension, "flat": {}}})
        }
    }
}

impl IndexRequirementField {
    /// This field as `firestore.indexes.json` spells it.
    #[must_use]
    pub fn config_entry(&self) -> serde_json::Value {
        match self.mode {
            IndexMode::Ordered(direction) => serde_json::json!({
                "fieldPath": self.field_path,
                "order": match direction {
                    IndexDirection::Ascending => "ASCENDING",
                    IndexDirection::Descending => "DESCENDING",
                },
            }),
            IndexMode::ArrayContains => serde_json::json!({
                "fieldPath": self.field_path,
                "arrayConfig": "CONTAINS",
            }),
            IndexMode::Vector(dimension) => serde_json::json!({
                "fieldPath": self.field_path,
                "vectorConfig": { "dimension": dimension, "flat": {} },
            }),
        }
    }
}

/// What [`IndexCatalog::advise`] found: the index production would require
/// for a query, and whether the project already declares it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexAdvice {
    pub requirement: IndexRequirement,
    pub declared: bool,
}

/// Parsed strict-index catalog.
#[derive(Debug, Default, Clone)]
pub struct IndexCatalog {
    indexes: Vec<IndexRequirement>,
    field_overrides: Vec<FieldOverride>,
}

impl IndexCatalog {
    /// Parses the checked-in CLI index format.
    pub fn from_json(json: &str) -> Result<Self, IndexConfigError> {
        let raw: RawCatalog = serde_json::from_str(json)
            .map_err(|error| IndexConfigError::InvalidJson(error.to_string()))?;
        let indexes = raw
            .indexes
            .into_iter()
            .map(IndexRequirement::try_from)
            .collect::<Result<Vec<_>, _>>()?;
        let field_overrides = raw
            .field_overrides
            .into_iter()
            .map(FieldOverride::try_from)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            indexes,
            field_overrides,
        })
    }

    /// Validates that automatic or declared indexes can serve `query`.
    ///
    /// This is only called when `--strict-indexes` is enabled. Collection
    /// automatic indexes are assumed unless a field override replaces them;
    /// collection-group automatic indexes must be declared explicitly.
    pub fn validate(&self, query: &Query) -> Result<(), IndexConfigError> {
        self.check(query, false)
    }

    /// [`Self::validate`] for an aggregation over `query`, which merged
    /// single-field indexes never serve (see [`composite_need`]).
    pub fn validate_aggregation(&self, query: &Query) -> Result<(), IndexConfigError> {
        self.check(query, true)
    }

    fn check(&self, query: &Query, aggregation: bool) -> Result<(), IndexConfigError> {
        let (collection_group, scope) = query_target(query.scope_ref());
        let usages = collect_usages(query);
        if usages.is_empty() {
            return Ok(());
        }

        if let Some(need) = composite_need(&collection_group, scope, &usages, query, aggregation) {
            if self.serves(&need) {
                return Ok(());
            }
            return Err(IndexConfigError::Missing(need.requirement));
        }

        for usage in usages.values() {
            let modes = usage.single_field_modes();
            for mode in modes {
                if !self.single_field_available(&collection_group, scope, &usage.path, mode) {
                    return Err(IndexConfigError::Missing(IndexRequirement {
                        collection_group: collection_group.clone(),
                        query_scope: scope,
                        fields: vec![IndexRequirementField {
                            field_path: usage.path.clone(),
                            mode,
                        }],
                    }));
                }
            }
        }
        Ok(())
    }

    /// The index a query needs in production, and whether this catalog
    /// declares it.
    ///
    /// Unlike [`IndexCatalog::validate`] this never fails a query: the local
    /// engine answers whatever it is asked, and a developer wants to know
    /// before deploying that a query which runs here would be refused in
    /// production for want of a composite index. A catalog that declares
    /// nothing names exactly what is required, because single-field indexes
    /// inside one collection are automatic there, so asking an empty catalog
    /// is the same question as "what must be declared".
    #[must_use]
    pub fn advise(&self, query: &Query) -> Option<IndexAdvice> {
        self.advice(query, false)
    }

    /// [`Self::advise`] for an aggregation over `query`.
    #[must_use]
    pub fn advise_aggregation(&self, query: &Query) -> Option<IndexAdvice> {
        self.advice(query, true)
    }

    fn advice(&self, query: &Query, aggregation: bool) -> Option<IndexAdvice> {
        let Err(IndexConfigError::Missing(requirement)) = Self::default().check(query, aggregation)
        else {
            return None;
        };
        Some(IndexAdvice {
            declared: self.check(query, aggregation).is_ok(),
            requirement,
        })
    }

    /// Whether the declared indexes serve a query that needs a composite
    /// one, by the rules Firestore documents
    /// (firebase.google.com/docs/firestore/query-data/index-overview):
    ///
    /// - One index serves it when it holds the query's equality and
    ///   array-contains fields first, in any order and, for an equality,
    ///   either direction, then exactly the query's ordering, direction for
    ///   direction (a reversed index is another index).
    /// - Several indexes serve a query of equalities and an `orderBy` alone
    ///   ("index merging"), when each ends with exactly that ordering and
    ///   between them they hold every equality field. A range or inequality
    ///   filter needs the one index.
    fn serves(&self, need: &CompositeNeed) -> bool {
        let (prefix, ordering) = need.requirement.fields.split_at(need.prefix);
        let candidates = self
            .indexes
            .iter()
            .filter(|index| {
                index.collection_group == need.requirement.collection_group
                    && index.query_scope == need.requirement.query_scope
            })
            .filter_map(|index| {
                let lead = index.fields.len().checked_sub(ordering.len())?;
                (index.fields[lead..] == *ordering).then(|| &index.fields[..lead])
            });
        let mut covered = BTreeSet::new();
        for lead in candidates {
            let fields = lead
                .iter()
                .map(|field| {
                    prefix
                        .iter()
                        .position(|wanted| prefix_field_matches(wanted, field))
                })
                .collect::<Option<BTreeSet<_>>>();
            let Some(fields) = fields.filter(|fields| fields.len() == lead.len()) else {
                continue;
            };
            if fields.len() == prefix.len() {
                return true;
            }
            if need.mergeable {
                covered.extend(fields);
            }
        }
        need.mergeable && covered.len() == prefix.len()
    }

    fn single_field_available(
        &self,
        collection_group: &str,
        scope: IndexScope,
        field_path: &str,
        mode: IndexMode,
    ) -> bool {
        let override_ = self.field_overrides.iter().find(|override_| {
            override_.collection_group == collection_group && override_.field_path == field_path
        });
        match (scope, override_) {
            (IndexScope::Collection, None) => true,
            (_, Some(override_)) => override_
                .indexes
                .contains(&SingleFieldIndex { scope, mode }),
            (IndexScope::CollectionGroup, None) => false,
        }
    }
}

#[derive(Debug, Clone)]
struct FieldOverride {
    collection_group: String,
    field_path: String,
    indexes: BTreeSet<SingleFieldIndex>,
}

impl TryFrom<RawFieldOverride> for FieldOverride {
    type Error = IndexConfigError;

    fn try_from(raw: RawFieldOverride) -> Result<Self, Self::Error> {
        let indexes = raw
            .indexes
            .into_iter()
            .map(|index| {
                Ok(SingleFieldIndex {
                    scope: index.query_scope.into(),
                    mode: index.mode()?,
                })
            })
            .collect::<Result<_, IndexConfigError>>()?;
        Ok(Self {
            collection_group: raw.collection_group,
            field_path: raw.field_path,
            indexes,
        })
    }
}

/// One index of a field override: the scope its queries run in and the
/// field's mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct SingleFieldIndex {
    pub scope: IndexScope,
    pub mode: IndexMode,
}

impl SingleFieldIndex {
    /// Reads one index of a field override's `indexes`.
    pub fn from_entry(entry: &serde_json::Value) -> Result<Self, IndexConfigError> {
        let raw = RawIndexMode::deserialize(entry)
            .map_err(|error| IndexConfigError::InvalidDefinition(error.to_string()))?;
        Ok(Self {
            scope: raw.query_scope.into(),
            mode: raw.mode()?,
        })
    }

    /// This index as `firestore.indexes.json` spells it.
    #[must_use]
    pub fn config_entry(&self) -> serde_json::Value {
        let mut entry = field_mode_entry(self.mode);
        entry["queryScope"] = serde_json::json!(match self.scope {
            IndexScope::Collection => "COLLECTION",
            IndexScope::CollectionGroup => "COLLECTION_GROUP",
        });
        entry
    }
}

/// One entry of the file's `fieldOverrides`: the indexes one field has in
/// place of the automatic ones (none: the field is not indexed at all), and
/// whether documents expire by it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldOverrideEntry {
    pub collection_group: String,
    pub field_path: String,
    pub indexes: Vec<SingleFieldIndex>,
    pub ttl: bool,
}

impl FieldOverrideEntry {
    /// Reads one entry of the file's `fieldOverrides`.
    pub fn from_entry(entry: &serde_json::Value) -> Result<Self, IndexConfigError> {
        let raw = RawFieldOverride::deserialize(entry)
            .map_err(|error| IndexConfigError::InvalidDefinition(error.to_string()))?;
        let indexes = raw
            .indexes
            .iter()
            .map(|index| {
                Ok(SingleFieldIndex {
                    scope: index.query_scope.into(),
                    mode: index.mode()?,
                })
            })
            .collect::<Result<_, IndexConfigError>>()?;
        Ok(Self {
            collection_group: raw.collection_group,
            field_path: raw.field_path,
            indexes,
            ttl: raw.ttl,
        })
    }
}

#[derive(Debug, Default)]
struct FieldUsage {
    path: String,
    equality: bool,
    inequality: bool,
    order: Option<IndexDirection>,
    special_modes: BTreeSet<IndexMode>,
}

impl FieldUsage {
    fn single_field_modes(&self) -> Vec<IndexMode> {
        let mut modes = Vec::new();
        modes.extend(self.special_modes.iter().copied());
        if let Some(order) = self.order {
            modes.push(IndexMode::Ordered(order));
        } else if self.inequality || self.equality {
            modes.push(IndexMode::Ordered(IndexDirection::Ascending));
        }
        modes
    }
}

fn collect_usages(query: &Query) -> BTreeMap<String, FieldUsage> {
    let mut usages = BTreeMap::new();
    if let Some(filter) = query.filter_ref() {
        collect_filter_usages(filter, &mut usages);
    }
    for order in query.orders_ref() {
        let Some(path) = order.path.config_name() else {
            continue;
        };
        let usage = usages.entry(path.clone()).or_insert_with(|| FieldUsage {
            path,
            ..FieldUsage::default()
        });
        usage.order = Some(order.direction.into());
    }
    if let Some(nearest) = query.nearest_ref()
        && let Some(path) = nearest.vector_field.config_name()
    {
        let usage = usages.entry(path.clone()).or_insert_with(|| FieldUsage {
            path,
            ..FieldUsage::default()
        });
        usage
            .special_modes
            .insert(IndexMode::Vector(nearest.query_vector.len()));
    }
    usages
}

fn collect_filter_usages(filter: &Filter, usages: &mut BTreeMap<String, FieldUsage>) {
    match filter {
        Filter::Field(filter) => {
            let Some(path) = filter.path.config_name() else {
                return;
            };
            let usage = usages.entry(path.clone()).or_insert_with(|| FieldUsage {
                path,
                ..FieldUsage::default()
            });
            match filter.operator {
                FieldOperator::Equal | FieldOperator::In => usage.equality = true,
                FieldOperator::ArrayContains | FieldOperator::ArrayContainsAny => {
                    usage.special_modes.insert(IndexMode::ArrayContains);
                }
                FieldOperator::LessThan
                | FieldOperator::LessThanOrEqual
                | FieldOperator::GreaterThan
                | FieldOperator::GreaterThanOrEqual
                | FieldOperator::NotEqual
                | FieldOperator::NotIn => usage.inequality = true,
            }
        }
        Filter::And(filters) | Filter::Or(filters) => {
            for filter in filters {
                collect_filter_usages(filter, usages);
            }
        }
    }
}

/// The composite index a query needs: the one to declare, how many of its
/// leading fields are equality or array-contains fields, which an index may
/// hold in any order, and whether merged indexes may serve it.
struct CompositeNeed {
    requirement: IndexRequirement,
    prefix: usize,
    mergeable: bool,
}

/// Whether a declared index field serves a query's equality or
/// array-contains field: the same field, ordered either way for an equality
/// ("you can use an ascending or descending index mode"), or array-contains.
fn prefix_field_matches(wanted: &IndexRequirementField, declared: &IndexRequirementField) -> bool {
    wanted.field_path == declared.field_path
        && match (wanted.mode, declared.mode) {
            (IndexMode::Ordered(_), IndexMode::Ordered(_)) => true,
            (wanted, declared) => wanted == declared,
        }
}

/// The composite index `query` needs, or `None` when single-field indexes
/// serve it. Its fields are the array-contains and equality fields, then the
/// query's ordering as Firestore normalizes it: the `orderBy` fields, then
/// each other inequality field in field-path order, in the direction of the
/// last `orderBy` (ascending without one), then a vector field.
///
/// An `aggregation` is served by one index, never by merged single-field
/// ones: production refuses a count and sum over two equality filters for
/// want of the composite index on those two fields (fixture `rest-v1`
/// production `aggregation-composite-filter/2`), where a query for the
/// documents is served by merging.
fn composite_need(
    collection_group: &str,
    scope: IndexScope,
    usages: &BTreeMap<String, FieldUsage>,
    query: &Query,
    aggregation: bool,
) -> Option<CompositeNeed> {
    let vector = usages.values().find_map(|usage| {
        usage.special_modes.iter().find_map(|mode| match mode {
            IndexMode::Vector(dimension) => Some((usage, *dimension)),
            IndexMode::Ordered(_) | IndexMode::ArrayContains => None,
        })
    });
    let contains = usages
        .values()
        .filter(|usage| usage.special_modes.contains(&IndexMode::ArrayContains))
        .collect::<Vec<_>>();
    let equality = usages
        .values()
        .filter(|usage| usage.equality && !usage.inequality && usage.order.is_none())
        .collect::<Vec<_>>();
    let range_or_order = usages
        .values()
        .filter(|usage| usage.inequality || usage.order.is_some())
        .collect::<Vec<_>>();
    let constrained = !equality.is_empty() || !contains.is_empty();
    let requires_manual = vector.is_some()
        || range_or_order.len() > 1
        || (constrained && range_or_order.iter().any(|usage| !usage.equality))
        || (aggregation && usages.len() > 1);
    if !requires_manual {
        return None;
    }

    let mut fields = contains
        .iter()
        .map(|usage| IndexRequirementField {
            field_path: usage.path.clone(),
            mode: IndexMode::ArrayContains,
        })
        .collect::<Vec<_>>();
    fields.extend(equality.iter().map(|usage| IndexRequirementField {
        field_path: usage.path.clone(),
        mode: IndexMode::Ordered(IndexDirection::Ascending),
    }));
    let prefix = fields.len();
    for (path, direction) in ordering(query, usages) {
        if fields.iter().all(|field| field.field_path != path) {
            fields.push(IndexRequirementField {
                field_path: path,
                mode: IndexMode::Ordered(direction),
            });
        }
    }
    if let Some((vector, dimension)) = vector
        && fields.iter().all(|field| field.field_path != vector.path)
    {
        fields.push(IndexRequirementField {
            field_path: vector.path.clone(),
            mode: IndexMode::Vector(dimension),
        });
    }
    Some(CompositeNeed {
        requirement: IndexRequirement {
            collection_group: collection_group.to_owned(),
            query_scope: scope,
            fields,
        },
        prefix,
        // Merging serves equalities and an order alone, for documents.
        mergeable: !aggregation
            && vector.is_none()
            && !usages.values().any(|usage| usage.inequality),
    })
}

/// The ordered fields of `query`, as Firestore normalizes them: each
/// `orderBy` in turn, then every other inequality field in field-path order
/// with the direction of the last `orderBy`, without the implicit document
/// name.
fn ordering(query: &Query, usages: &BTreeMap<String, FieldUsage>) -> Vec<(String, IndexDirection)> {
    let mut ordered = query
        .orders_ref()
        .iter()
        .filter_map(|order| {
            Some((
                order.path.config_name()?,
                IndexDirection::from(order.direction),
            ))
        })
        .collect::<Vec<_>>();
    let direction = query
        .orders_ref()
        .last()
        .map_or(IndexDirection::Ascending, |order| order.direction.into());
    let mut inequalities = BTreeSet::new();
    if let Some(filter) = query.filter_ref() {
        collect_inequality_paths(filter, &mut inequalities);
    }
    for path in inequalities {
        if let Some(name) = path.config_name()
            && usages.contains_key(&name)
            && ordered.iter().all(|(ordered, _)| *ordered != name)
        {
            ordered.push((name, direction));
        }
    }
    ordered
}

fn collect_inequality_paths(filter: &Filter, paths: &mut BTreeSet<crate::query::FieldPath>) {
    match filter {
        Filter::Field(filter) => {
            if matches!(
                filter.operator,
                FieldOperator::LessThan
                    | FieldOperator::LessThanOrEqual
                    | FieldOperator::GreaterThan
                    | FieldOperator::GreaterThanOrEqual
                    | FieldOperator::NotEqual
                    | FieldOperator::NotIn
            ) {
                paths.insert(filter.path.clone());
            }
        }
        Filter::And(filters) | Filter::Or(filters) => {
            for filter in filters {
                collect_inequality_paths(filter, paths);
            }
        }
    }
}

fn query_target(scope: &StructuredQueryScope) -> (String, IndexScope) {
    match scope {
        StructuredQueryScope::Collection(path) => (
            path.rsplit('/').next().unwrap_or_default().to_owned(),
            IndexScope::Collection,
        ),
        StructuredQueryScope::CollectionGroup(collection_group) => {
            (collection_group.clone(), IndexScope::CollectionGroup)
        }
        // Only `__name__` may filter or order it, which no index serves.
        StructuredQueryScope::AllDescendants => (String::new(), IndexScope::CollectionGroup),
    }
}

impl TryFrom<RawIndex> for IndexRequirement {
    type Error = IndexConfigError;

    fn try_from(raw: RawIndex) -> Result<Self, Self::Error> {
        let fields = raw
            .fields
            .into_iter()
            .map(|field| {
                let mode = field.mode()?;
                Ok(IndexRequirementField {
                    field_path: field.field_path,
                    mode,
                })
            })
            .collect::<Result<_, IndexConfigError>>()?;
        Ok(Self {
            collection_group: raw.collection_group,
            query_scope: raw.query_scope.into(),
            fields: without_implicit_document_name(fields),
        })
    }
}

/// Drops a trailing `__name__` that only restates the previous field's
/// direction.
///
/// Firestore appends the document name to every index, and the Firebase CLI
/// writes it out explicitly in some of the entries it generates. A
/// requirement derived from a query never carries it, so a declared index
/// that spells it out would not compare equal and a query whose index the
/// project already declares would be reported as missing. A `__name__` whose
/// direction differs from the field before it does carry information, so it
/// stays.
fn without_implicit_document_name(
    mut fields: Vec<IndexRequirementField>,
) -> Vec<IndexRequirementField> {
    if fields.len() < 2 {
        return fields;
    }
    let [.., previous, last] = fields.as_slice() else {
        return fields;
    };
    if last.field_path == DOCUMENT_NAME && last.mode == previous.mode {
        fields.pop();
    }
    fields
}

impl From<RawScope> for IndexScope {
    fn from(scope: RawScope) -> Self {
        match scope {
            RawScope::Collection => Self::Collection,
            RawScope::CollectionGroup => Self::CollectionGroup,
        }
    }
}

impl From<RawDirection> for IndexDirection {
    fn from(direction: RawDirection) -> Self {
        match direction {
            RawDirection::Ascending => Self::Ascending,
            RawDirection::Descending => Self::Descending,
        }
    }
}

impl From<Direction> for IndexDirection {
    fn from(direction: Direction) -> Self {
        match direction {
            Direction::Ascending => Self::Ascending,
            Direction::Descending => Self::Descending,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RawCatalog {
    indexes: Vec<RawIndex>,
    field_overrides: Vec<RawFieldOverride>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawIndex {
    collection_group: String,
    #[serde(default)]
    query_scope: RawScope,
    fields: Vec<RawIndexField>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawFieldOverride {
    collection_group: String,
    field_path: String,
    #[serde(default)]
    indexes: Vec<RawIndexMode>,
    #[serde(default)]
    ttl: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawIndexField {
    field_path: String,
    #[serde(alias = "mode")]
    order: Option<RawDirection>,
    array_config: Option<RawArrayConfig>,
    vector_config: Option<RawVectorConfig>,
}

impl RawIndexField {
    fn mode(&self) -> Result<IndexMode, IndexConfigError> {
        raw_mode(self.order, self.array_config, self.vector_config.as_ref())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawIndexMode {
    #[serde(default)]
    query_scope: RawScope,
    order: Option<RawDirection>,
    array_config: Option<RawArrayConfig>,
    vector_config: Option<RawVectorConfig>,
}

impl RawIndexMode {
    fn mode(&self) -> Result<IndexMode, IndexConfigError> {
        raw_mode(self.order, self.array_config, self.vector_config.as_ref())
    }
}

fn raw_mode(
    order: Option<RawDirection>,
    array_config: Option<RawArrayConfig>,
    vector_config: Option<&RawVectorConfig>,
) -> Result<IndexMode, IndexConfigError> {
    match (order, array_config, vector_config) {
        (Some(order), None, None) => Ok(IndexMode::Ordered(order.into())),
        (None, Some(RawArrayConfig::Contains), None) => Ok(IndexMode::ArrayContains),
        (None, None, Some(config)) if config.dimension > 0 => {
            Ok(IndexMode::Vector(config.dimension))
        }
        _ => Err(IndexConfigError::InvalidDefinition(
            "an index field must define exactly one mode".to_owned(),
        )),
    }
}

#[derive(Debug, Deserialize)]
struct RawVectorConfig {
    dimension: usize,
    #[serde(rename = "flat")]
    _flat: RawFlatVectorConfig,
}

#[derive(Debug, Deserialize)]
struct RawFlatVectorConfig {}

#[derive(Debug, Default, Clone, Copy, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum RawScope {
    #[default]
    Collection,
    CollectionGroup,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum RawDirection {
    Ascending,
    Descending,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum RawArrayConfig {
    Contains,
}

/// Invalid index file or a missing strict-mode requirement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IndexConfigError {
    InvalidJson(String),
    InvalidDefinition(String),
    Missing(IndexRequirement),
}

impl Display for IndexConfigError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidJson(error) => write!(formatter, "invalid index JSON: {error}"),
            Self::InvalidDefinition(error) => {
                write!(formatter, "invalid index definition: {error}")
            }
            Self::Missing(requirement) => formatter.write_str(&requirement.missing_message()),
        }
    }
}

impl Error for IndexConfigError {}

#[cfg(test)]
mod tests {
    use firenook_core_store::Value;

    use super::*;
    use crate::{FieldFilter, FieldPath, Filter};

    const INDEXES: &str = r#"{
      "indexes": [
        {
          "collectionGroup": "items",
          "queryScope": "COLLECTION",
          "fields": [
            { "fieldPath": "group", "order": "ASCENDING" },
            { "fieldPath": "score", "order": "ASCENDING" }
          ]
        },
        {
          "collectionGroup": "vectors",
          "queryScope": "COLLECTION",
          "fields": [
            { "fieldPath": "embedding", "vectorConfig": { "dimension": 3, "flat": {} } }
          ]
        }
      ],
      "fieldOverrides": [
        {
          "collectionGroup": "firenook_conformance",
          "fieldPath": "runId",
          "indexes": [
            { "order": "ASCENDING", "queryScope": "COLLECTION" },
            { "order": "ASCENDING", "queryScope": "COLLECTION_GROUP" }
          ]
        }
      ]
    }"#;

    fn field(name: &str) -> FieldPath {
        FieldPath::field([name]).expect("valid field")
    }

    fn equality(name: &str) -> Filter {
        Filter::Field(FieldFilter {
            path: field(name),
            operator: FieldOperator::Equal,
            value: Value::String("value".into()),
        })
    }

    fn vector_query(collection: &str) -> Query {
        Query::new(
            StructuredQueryScope::collection(format!("runs/run/{collection}"))
                .expect("valid scope"),
        )
        .find_nearest(
            field("embedding"),
            vec![0.0, 0.0, 0.0],
            crate::DistanceMeasure::Euclidean,
            3,
            None,
            None,
        )
        .expect("valid vector query")
    }

    #[test]
    fn vector_indexes_are_always_explicit() {
        let catalog = IndexCatalog::from_json(INDEXES).expect("catalog should parse");
        catalog
            .validate(&vector_query("vectors"))
            .expect("declared vector index should match");
        assert!(matches!(
            catalog.validate(&vector_query("missing_vectors")),
            Err(IndexConfigError::Missing(IndexRequirement { fields, .. }))
                if fields == [IndexRequirementField {
                    field_path: "embedding".to_owned(),
                    mode: IndexMode::Vector(3),
                }]
        ));
    }

    #[test]
    fn collection_group_single_field_indexes_are_explicit() {
        let catalog = IndexCatalog::from_json(INDEXES).expect("catalog should parse");
        let query = Query::new(
            StructuredQueryScope::collection_group("firenook_conformance").expect("valid scope"),
        )
        .filter(equality("runId"));
        catalog.validate(&query).expect("override should match");

        let missing = Query::new(
            StructuredQueryScope::collection_group("firenook_conformance").expect("valid scope"),
        )
        .filter(equality("other"));
        assert!(matches!(
            catalog.validate(&missing),
            Err(IndexConfigError::Missing(IndexRequirement {
                query_scope: IndexScope::CollectionGroup,
                ..
            }))
        ));
    }

    #[test]
    fn collection_automatic_and_composite_indexes_are_distinguished() {
        let catalog = IndexCatalog::from_json(INDEXES).expect("catalog should parse");
        let simple =
            Query::new(StructuredQueryScope::collection("parents/p/items").expect("valid scope"))
                .filter(equality("group"));
        catalog
            .validate(&simple)
            .expect("automatic equality index should suffice");

        let composite =
            Query::new(StructuredQueryScope::collection("parents/p/items").expect("valid scope"))
                .filter(equality("group"))
                .order_by(field("score"), Direction::Ascending);
        catalog
            .validate(&composite)
            .expect("declared composite should match");

        let missing =
            Query::new(StructuredQueryScope::collection("parents/p/items").expect("valid scope"))
                .filter(equality("group"))
                .order_by(field("created"), Direction::Ascending);
        assert!(matches!(
            catalog.validate(&missing),
            Err(IndexConfigError::Missing(_))
        ));
    }

    /// A catalog of the composite indexes on `items`, each spelled as
    /// `"a"`, `"a desc"` or `"a contains"`.
    fn declared(scope: &str, indexes: &[&[&str]]) -> IndexCatalog {
        let indexes = indexes
            .iter()
            .map(|fields| {
                let fields = fields
                    .iter()
                    .map(|field| match field.split_once(' ') {
                        Some((path, "desc")) => {
                            format!(r#"{{"fieldPath":"{path}","order":"DESCENDING"}}"#)
                        }
                        Some((path, "contains")) => {
                            format!(r#"{{"fieldPath":"{path}","arrayConfig":"CONTAINS"}}"#)
                        }
                        _ => format!(r#"{{"fieldPath":"{field}","order":"ASCENDING"}}"#),
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                format!(
                    r#"{{"collectionGroup":"items","queryScope":"{scope}","fields":[{fields}]}}"#
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        IndexCatalog::from_json(&format!(r#"{{"indexes":[{indexes}]}}"#)).expect("catalog")
    }

    fn filter(name: &str, operator: FieldOperator, value: Value) -> Filter {
        Filter::Field(FieldFilter {
            path: field(name),
            operator,
            value,
        })
    }

    fn items() -> Query {
        Query::new(StructuredQueryScope::collection("items").expect("valid scope"))
    }

    fn needed(catalog: &IndexCatalog, query: &Query) -> Option<Vec<String>> {
        let advice = catalog.advise(query)?;
        (!advice.declared).then(|| {
            advice
                .requirement
                .fields
                .iter()
                .map(|field| match field.mode {
                    IndexMode::Ordered(IndexDirection::Descending) => {
                        format!("{} desc", field.field_path)
                    }
                    IndexMode::ArrayContains => format!("{} contains", field.field_path),
                    _ => field.field_path.clone(),
                })
                .collect()
        })
    }

    /// Equality fields serve in any order and either direction; the
    /// ordering after them must match exactly, and a reversed index is
    /// another index (firebase.google.com/docs/firestore/query-data/index-overview).
    #[test]
    fn an_index_serves_equalities_in_any_order_and_direction_then_exactly_the_ordering() {
        let query = items()
            .filter(Filter::And(vec![equality("a"), equality("d")]))
            .order_by(field("b"), Direction::Ascending);
        assert_eq!(
            needed(&declared("COLLECTION", &[&["d", "a", "b"]]), &query),
            None
        );
        assert_eq!(
            needed(&declared("COLLECTION", &[&["a desc", "d", "b"]]), &query),
            None
        );
        assert_eq!(
            needed(&declared("COLLECTION", &[&["a", "d", "b desc"]]), &query),
            Some(vec!["a".into(), "d".into(), "b".into()])
        );
        // An extra field leaves the documents without it out of the index.
        assert!(needed(&declared("COLLECTION", &[&["a", "x", "d", "b"]]), &query).is_some());
        // A collection group index does not serve a collection query.
        assert!(needed(&declared("COLLECTION_GROUP", &[&["a", "d", "b"]]), &query).is_some());

        let descending = items()
            .filter(equality("country"))
            .order_by(field("population"), Direction::Descending);
        assert_eq!(
            needed(
                &declared("COLLECTION", &[&["country", "population"]]),
                &descending
            ),
            Some(vec!["country".into(), "population desc".into()])
        );
        assert_eq!(
            needed(
                &declared("COLLECTION", &[&["country desc", "population desc"]]),
                &descending
            ),
            None
        );
    }

    /// "For queries with multiple equality (==) clauses and, optionally, an
    /// orderBy clause, Cloud Firestore can re-use existing indexes", each
    /// ending with the order; a range filter needs the one index.
    #[test]
    fn indexes_merge_for_equalities_and_an_order_but_not_for_a_range() {
        let ordered = items()
            .filter(Filter::And(vec![equality("a"), equality("d")]))
            .order_by(field("c"), Direction::Ascending);
        let merged = declared("COLLECTION", &[&["a", "c"], &["d desc", "c"]]);
        assert_eq!(needed(&merged, &ordered), None);
        assert!(needed(&declared("COLLECTION", &[&["a", "c"]]), &ordered).is_some());
        assert!(
            needed(
                &declared("COLLECTION", &[&["a", "c"], &["d", "c desc"]]),
                &ordered
            )
            .is_some()
        );
        let in_list = items()
            .filter(Filter::And(vec![
                equality("a"),
                filter(
                    "d",
                    FieldOperator::In,
                    Value::Array(vec![Value::Integer(1)]),
                ),
            ]))
            .order_by(field("c"), Direction::Ascending);
        assert_eq!(needed(&merged, &in_list), None);

        let ranged = items().filter(Filter::And(vec![
            equality("a"),
            equality("d"),
            filter("c", FieldOperator::GreaterThan, Value::Integer(5)),
        ]));
        assert_eq!(
            needed(&merged, &ranged),
            Some(vec!["a".into(), "d".into(), "c".into()])
        );
        assert_eq!(
            needed(&declared("COLLECTION", &[&["d", "a", "c"]]), &ranged),
            None
        );
    }

    /// The ordering is the `orderBy` fields in turn, then each other
    /// inequality field in field-path order, in the direction of the last
    /// `orderBy` (cloud.google.com/firestore/docs/reference/rest/v1/StructuredQuery).
    #[test]
    fn the_ordering_follows_order_by_then_inequality_fields_in_path_order() {
        let ranges = items().filter(Filter::And(vec![
            filter("salary", FieldOperator::GreaterThan, Value::Integer(1)),
            filter("experience", FieldOperator::GreaterThan, Value::Integer(0)),
        ]));
        assert_eq!(
            needed(&IndexCatalog::default(), &ranges),
            Some(vec!["experience".into(), "salary".into()])
        );
        let after_order = items()
            .filter(filter("x", FieldOperator::GreaterThan, Value::Integer(1)))
            .order_by(field("y"), Direction::Descending);
        assert_eq!(
            needed(&IndexCatalog::default(), &after_order),
            Some(vec!["y desc".into(), "x desc".into()])
        );
        let explicit = items()
            .filter(equality("a"))
            .order_by(field("z"), Direction::Ascending)
            .order_by(field("b"), Direction::Ascending);
        assert_eq!(
            needed(&IndexCatalog::default(), &explicit),
            Some(vec!["a".into(), "z".into(), "b".into()])
        );
        assert!(needed(&declared("COLLECTION", &[&["a", "b", "z"]]), &explicit).is_some());
    }

    /// array-contains is served beside equalities by single-field indexes,
    /// and beside an order on another field only by a composite index.
    #[test]
    fn array_contains_needs_a_composite_index_only_beside_an_order() {
        let contains = filter(
            "tags",
            FieldOperator::ArrayContains,
            Value::String("x".into()),
        );
        let with_equality =
            items().filter(Filter::And(vec![contains.clone(), equality("capital")]));
        assert_eq!(IndexCatalog::default().advise(&with_equality), None);
        let ordered = items()
            .filter(contains)
            .order_by(field("created"), Direction::Descending);
        assert_eq!(
            needed(&IndexCatalog::default(), &ordered),
            Some(vec!["tags contains".into(), "created desc".into()])
        );
        assert_eq!(
            needed(
                &declared("COLLECTION", &[&["tags contains", "created desc"]]),
                &ordered
            ),
            None
        );
    }

    /// Equalities alone, and one inequality ordered by its own field, need
    /// no composite index.
    #[test]
    fn single_field_indexes_serve_equalities_and_one_ordered_inequality() {
        let equalities = items().filter(Filter::And(vec![
            equality("a"),
            equality("b"),
            equality("c"),
        ]));
        assert_eq!(IndexCatalog::default().advise(&equalities), None);
        let one_range = items()
            .filter(filter(
                "population",
                FieldOperator::GreaterThan,
                Value::Integer(2),
            ))
            .order_by(field("population"), Direction::Descending);
        assert_eq!(IndexCatalog::default().advise(&one_range), None);
    }

    /// An aggregation is answered from one index: production refuses a
    /// count and sum over equalities on `synthetic` and `sequence` for want
    /// of the composite index on (`sequence`, `synthetic`) (fixture
    /// `rest-v1` production `aggregation-composite-filter/2`), the
    /// documents of which merged single-field indexes serve.
    #[test]
    fn an_aggregation_over_two_equalities_needs_their_composite_index() {
        let equalities = items().filter(Filter::And(vec![
            filter("synthetic", FieldOperator::Equal, Value::Boolean(true)),
            filter("sequence", FieldOperator::Equal, Value::Integer(1)),
        ]));
        let empty = IndexCatalog::default();
        assert_eq!(empty.advise(&equalities), None);
        assert!(empty.validate(&equalities).is_ok());
        let advice = empty
            .advise_aggregation(&equalities)
            .expect("an aggregation needs a composite index");
        assert!(!advice.declared);
        assert_eq!(
            advice.requirement.config_entry(),
            serde_json::json!({
                "collectionGroup": "items",
                "queryScope": "COLLECTION",
                "fields": [
                    {"fieldPath": "sequence", "order": "ASCENDING"},
                    {"fieldPath": "synthetic", "order": "ASCENDING"},
                ],
            })
        );
        assert_eq!(
            empty.validate_aggregation(&equalities),
            Err(IndexConfigError::Missing(advice.requirement))
        );
        // The equality fields in either order and direction serve it.
        let declared_index = declared("COLLECTION", &[&["synthetic desc", "sequence"]]);
        assert!(declared_index.validate_aggregation(&equalities).is_ok());
        assert!(
            declared_index
                .advise_aggregation(&equalities)
                .is_some_and(|advice| advice.declared)
        );
        // Merged indexes, which serve the documents ordered by `rank`, do
        // not serve the aggregation.
        let ordered = equalities
            .clone()
            .order_by(field("rank"), Direction::Ascending);
        let merged = declared(
            "COLLECTION",
            &[&["sequence", "rank"], &["synthetic", "rank"]],
        );
        assert_eq!(needed(&merged, &ordered), None);
        assert!(merged.validate_aggregation(&ordered).is_err());
        // One field is served by its automatic index.
        let one = items().filter(equality("sequence"));
        assert_eq!(empty.advise_aggregation(&one), None);
    }

    /// A single-field index a collection group query needs is declared by a
    /// field override, which keeps the field's automatic indexes.
    #[test]
    fn a_missing_single_field_index_is_declared_by_an_override_that_keeps_the_defaults() {
        let group = Query::new(StructuredQueryScope::collection_group("items").expect("scope"))
            .filter(equality("a"));
        let advice = IndexCatalog::default()
            .advise(&group)
            .expect("an override is needed");
        let (list, entry) = advice.requirement.declaration();
        assert_eq!(list, "fieldOverrides");
        assert_eq!(entry["fieldPath"], "a");
        assert_eq!(entry["indexes"].as_array().expect("indexes").len(), 4);
        assert!(advice.requirement.missing_message().starts_with(
            "The query requires a single-field index on \"items\" for collection group queries"
        ));
        let catalog = IndexCatalog::from_json(&format!(r#"{{"fieldOverrides":[{entry}]}}"#))
            .expect("catalog");
        assert!(catalog.advise(&group).expect("advice").declared);
    }

    /// A field the file already overrides keeps its override: the entry is
    /// that override with the index required added, not a second override,
    /// and an exemption it makes stays made.
    #[test]
    fn a_field_already_overridden_keeps_its_override_with_the_index_added() {
        let catalog = IndexCatalog::from_json(
            r#"{"fieldOverrides":[{"collectionGroup":"items","fieldPath":"a","ttl":true,
                "indexes":[{"order":"ASCENDING","queryScope":"COLLECTION"}]}]}"#,
        )
        .expect("catalog");
        let group = Query::new(StructuredQueryScope::collection_group("items").expect("scope"))
            .filter(equality("a"));
        let advice = catalog.advise(&group).expect("advice");
        assert!(!advice.declared);
        let (list, entry) = advice.requirement.declaration_in(&catalog);
        assert_eq!(list, "fieldOverrides");
        assert_eq!(
            entry["indexes"],
            serde_json::json!([
                {"order": "ASCENDING", "queryScope": "COLLECTION"},
                {"order": "ASCENDING", "queryScope": "COLLECTION_GROUP"},
            ])
        );
        let read = FieldOverrideEntry::from_entry(&entry).expect("an override");
        assert_eq!(read.indexes.len(), 2);
        assert!(!read.ttl);
        let declared = IndexCatalog::from_json(&format!(r#"{{"fieldOverrides":[{entry}]}}"#))
            .expect("catalog");
        assert!(declared.advise(&group).expect("advice").declared);
    }

    /// One entry of the file reads as the catalog reads it: the implicit
    /// `__name__` dropped, the CLI's `mode` alias accepted, a bad mode said.
    #[test]
    fn one_entry_reads_as_the_catalog_reads_it() {
        let entry = serde_json::json!({
            "collectionGroup": "items",
            "queryScope": "COLLECTION",
            "fields": [
                {"fieldPath": "a", "mode": "ASCENDING"},
                {"fieldPath": "b", "order": "DESCENDING"},
                {"fieldPath": "__name__", "order": "DESCENDING"},
            ],
        });
        let read = IndexRequirement::from_entry(&entry).expect("an index");
        assert_eq!(read.fields.len(), 2);
        assert_eq!(read.config_entry()["fields"][0]["order"], "ASCENDING");
        let bad = serde_json::json!({"collectionGroup": "items", "fields": [{"fieldPath": "a"}]});
        assert!(matches!(
            IndexRequirement::from_entry(&bad),
            Err(IndexConfigError::InvalidDefinition(_))
        ));
        assert_eq!(
            SingleFieldIndex::from_entry(&serde_json::json!({"arrayConfig": "CONTAINS"}))
                .expect("an index"),
            SingleFieldIndex {
                scope: IndexScope::Collection,
                mode: IndexMode::ArrayContains,
            }
        );
        let ttl = FieldOverrideEntry::from_entry(
            &serde_json::json!({"collectionGroup": "items", "fieldPath": "at", "ttl": true, "indexes": []}),
        )
        .expect("an override");
        assert!(ttl.ttl && ttl.indexes.is_empty());
    }
}
