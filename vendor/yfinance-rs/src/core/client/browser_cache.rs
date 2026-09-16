use super::BoundedSideMap;

pub(super) struct Cache<K, V> {
    entries: BoundedSideMap<K, V>,
}

impl<V: Clone + Send + Sync + 'static> Cache<String, V> {
    pub(super) fn new(capacity: usize) -> Self {
        Self {
            entries: BoundedSideMap::new(capacity),
        }
    }

    pub(super) fn get(&self, key: &str) -> Option<V> {
        self.entries.get_str(key)
    }

    pub(super) fn insert(&self, key: String, value: V) {
        self.entries.insert(key, value);
    }

    pub(super) fn invalidate(&self, key: &str) {
        let mut entries = self.entries.entries.write().expect("cache lock poisoned");
        entries.values.remove(key);
        entries.insertion_order.retain(|k| k != key);
    }

    pub(super) fn invalidate_all(&self) {
        self.entries.clear();
    }

    pub(super) fn invalidate_entries_if(&self, predicate: impl Fn(&String, &V) -> bool) {
        let mut entries = self.entries.entries.write().expect("cache lock poisoned");
        entries.values.retain(|key, value| !predicate(key, value));
        let super::BoundedSideEntries {
            values,
            insertion_order,
            ..
        } = &mut *entries;
        insertion_order.retain(|key| values.contains_key(key));
    }

    // Browser writes are synchronous; Moka performs this work on its worker threads.
    pub(super) fn run_pending_tasks(&self) {}
}
