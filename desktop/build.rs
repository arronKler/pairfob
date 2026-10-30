fn main() {
    // `update::VERSION` embeds this at compile time; without the hint Cargo
    // could reuse an object compiled for an earlier release version.
    println!("cargo:rerun-if-env-changed=PAIRFOB_DESKTOP_VERSION");
}
