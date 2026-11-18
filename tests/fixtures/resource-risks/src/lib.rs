//! Controlled compiler facts. Resource and cost meanings exist only in test models.
#[inline(never)]
pub fn allocate(size: usize) -> usize {
    size
}
#[inline(never)]
pub fn within_limit(size: usize) -> bool {
    size <= 64
}
pub fn unknown_size(size: usize) -> usize {
    allocate(size)
}
pub fn declared_bounded(size: usize) -> usize {
    allocate(size)
}
pub fn guarded_size(size: usize) -> usize {
    if within_limit(size) {
        allocate(size)
    } else {
        0
    }
}
pub fn loop_work(size: usize, again: bool) -> usize {
    let mut result = 0;
    while again {
        result = allocate(size);
    }
    result
}
pub fn nested_work(size: usize, outer: bool, inner: bool) -> usize {
    let mut result = 0;
    while outer {
        while inner {
            result = allocate(size);
        }
    }
    result
}
pub fn unsupported_mutex(size: usize, lock: &std::sync::Mutex<usize>) -> usize {
    let guard = lock.lock().unwrap();
    allocate(size) + *guard
}
pub fn unsupported_raii(size: usize) -> usize {
    let data = vec![size];
    allocate(data[0])
}
pub async fn unsupported_async(size: usize) -> usize {
    std::future::ready(()).await;
    allocate(size)
}
unsafe extern "C" {
    fn resource_fixture_external(size: usize) -> usize;
}
pub unsafe fn unsupported_native(size: usize) -> usize {
    allocate(unsafe { resource_fixture_external(size) })
}
