//! Work on a stopped store's file: what it holds, and compaction.

use std::fs;
use std::path::Path;
use std::time::Duration;

use redb::{Builder, ReadableDatabase, ReadableTableMetadata as _, TableHandle as _};

use super::{DATABASE_FILE, DiskError, DiskOptions, DiskStore};

/// One table of the store's file, from redb's own statistics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableSize {
    /// The table's name in the file.
    pub name: String,
    /// Entries in the table.
    pub entries: u64,
    /// Its keys and values.
    pub stored_bytes: u64,
    /// Its tree's own pages and page headers.
    pub metadata_bytes: u64,
    /// Unused room in its pages.
    pub fragmented_bytes: u64,
}

impl TableSize {
    /// Every page the table takes up.
    #[must_use]
    pub const fn page_bytes(&self) -> u64 {
        self.stored_bytes
            .saturating_add(self.metadata_bytes)
            .saturating_add(self.fragmented_bytes)
    }
}

/// What a stopped store's file holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreSize {
    /// The file's size on disk.
    pub file_bytes: u64,
    /// Every table, in the file's order.
    pub tables: Vec<TableSize>,
    /// Whether the file needed a repair first: its last stop did not close
    /// it.
    pub repaired: bool,
}

impl StoreSize {
    /// The part of the file in no table: free pages, which only a
    /// compaction returns to the disk, and redb's own records.
    #[must_use]
    pub fn outside_tables(&self) -> u64 {
        let tables = self
            .tables
            .iter()
            .fold(0_u64, |sum, table| sum.saturating_add(table.page_bytes()));
        self.file_bytes.saturating_sub(tables)
    }
}

/// Reads every page of a stopped store's file once, which takes minutes
/// for tens of gigabytes, and changes nothing in it unless it is marked for
/// repair: then it is repaired first, as the next open would.
pub fn inspect(directory: &Path) -> Result<StoreSize, DiskError> {
    let path = directory.join(DATABASE_FILE);
    let file_bytes = fs::metadata(&path)?.len();
    // A read-only open refuses a file still marked for repair.
    let (tables, repaired) = if let Ok(database) = Builder::new().open_read_only(&path) {
        (tables(&database)?, false)
    } else {
        let database = Builder::new().open(&path).map_err(DiskError::redb)?;
        (tables(&database)?, true)
    };
    Ok(StoreSize {
        file_bytes,
        tables,
        repaired,
    })
}

fn tables(database: &impl ReadableDatabase) -> Result<Vec<TableSize>, DiskError> {
    let transaction = database.begin_read().map_err(DiskError::redb)?;
    let mut tables = Vec::new();
    for handle in transaction.list_tables().map_err(DiskError::redb)? {
        let table = transaction
            .open_untyped_table(handle.clone())
            .map_err(DiskError::redb)?;
        let stats = table.stats().map_err(DiskError::redb)?;
        tables.push(TableSize {
            name: handle.name().to_owned(),
            entries: table.len().map_err(DiskError::redb)?,
            stored_bytes: stats.stored_bytes(),
            metadata_bytes: stats.metadata_bytes(),
            fragmented_bytes: stats.fragmented_bytes(),
        });
    }
    Ok(tables)
}

/// What a compaction did to the store's file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Compaction {
    /// The file's size before.
    pub before_bytes: u64,
    /// And after.
    pub after_bytes: u64,
}

/// Compacts a stopped store. It is opened through the store first, so a
/// journal a crash left replays and the file is closed cleanly; then redb
/// moves pages into free space and truncates the file. Lossless: every step
/// is an ordinary commit. Interrupted, the file is left to a repair at the
/// next open, one that reads all of it.
pub fn compact(directory: &Path, options: DiskOptions) -> Result<Compaction, DiskError> {
    let path = directory.join(DATABASE_FILE);
    let before_bytes = fs::metadata(&path)?.len();
    // The write-behind flusher may hold the store for a moment.
    DiskStore::open(directory, options)?.close(Duration::from_secs(5))?;
    let mut database = Builder::new().open(&path).map_err(DiskError::redb)?;
    // A pass moves what it can; the next one finds less to move.
    for _ in 0..8 {
        if !database.compact().map_err(DiskError::redb)? {
            break;
        }
    }
    drop(database);
    Ok(Compaction {
        before_bytes,
        after_bytes: fs::metadata(&path)?.len(),
    })
}
