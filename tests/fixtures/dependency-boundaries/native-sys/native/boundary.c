extern int rust_boundary_callback(int value);

#if defined(__GNUC__) || defined(__clang__)
__attribute__((noinline))
#endif
int boundary_helper(int value) {
    return value + 11;
}

int boundary_c_entry(int value) {
    return rust_boundary_callback(boundary_helper(value));
}
