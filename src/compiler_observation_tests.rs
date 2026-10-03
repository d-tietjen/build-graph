//! Data validation controls; genuine compiler positives are separate integration cases.
use crate::compiler_context::*;
use crate::compiler_semantic::*;
use crate::compiler_test_harness::*;

fn identity(local: bool, index: u32) -> CompilerDefinitionObservation {
    CompilerDefinitionObservation {
        crate_name: if local { "demo" } else { "test" }.into(),
        stable_crate_id: if local { "1" } else { "2" }.repeat(16),
        crate_hash: if local { "3" } else { "4" }.repeat(32),
        def_path_hash: format!("{index:032x}"),
        definition_index: index,
        compiler_path: format!("item_{index}"),
    }
}
fn header(count: u64) -> TestHarnessEntryObservation {
    let runner = identity(false, 2);
    TestHarnessEntryObservation {
        entry: identity(true, 1),
        origin: TestHarnessOrigin::RustcTestHarness,
        runner: runner.clone(),
        descriptor_type: identity(false, 3),
        test_crate: CompilerTestCrateObservation {
            crate_name: runner.crate_name,
            stable_crate_id: runner.stable_crate_id,
            crate_hash: runner.crate_hash,
            members: vec![CompilerSysrootMemberObservation {
                kind: CompilerSysrootMemberKind::Rlib,
                relative: "lib/rustlib/target/lib/libtest.rlib".into(),
            }],
        },
        table_entries: count,
    }
}
fn descriptor(name: &str, ordinal: u64) -> TestDescriptorObservation {
    TestDescriptorObservation {
        table_ordinal: ordinal,
        constant: identity(true, 10 + ordinal as u32),
        descriptor_type: identity(false, 3),
        name: name.into(),
        kind: TestDescriptorKind::Test,
        ignore: true,
        ignore_message: Some("reason".into()),
        compile_fail: false,
        no_run: false,
        should_panic: TestPanicExpectation::Message {
            value: "expected".into(),
        },
        test_type: CompilerTestType::Unit,
        source_file: "src/lib.rs".into(),
        start_line: 1,
        start_column: 0,
        end_line: 1,
        end_column: 4,
        closure: identity(true, 20),
        function: identity(true, 21),
        assertion_wrapper: identity(false, 22),
        name_constructor: identity(false, 23),
        function_constructor: identity(false, 24),
        panic_variant: identity(false, 25),
        test_type_variant: identity(false, 26),
    }
}
fn context(cfg: u64, stable: u64, all: u64) -> SemanticTarget {
    SemanticTarget::CompilerContext {
        context: Box::new(CompilerContextObservation {
            provenance: CompilerContextProvenance::RustcSessionAfterAnalysis,
            rustc_version: "rustc actual compiler version".into(),
            target_llvm: "target".into(),
            target_arch: "arch".into(),
            cfg_entries: cfg,
            stable_target_feature_entries: stable,
            all_target_feature_entries: all,
        }),
    }
}
fn stream(domain: SemanticDomain, targets: Vec<SemanticTarget>) -> SemanticStreamV1 {
    let binding = SemanticBindingV1 {
        schema_version: 1,
        nonce: "owned-callback".into(),
        command_fingerprint: crate::compiler_occurrence::fingerprint(b"owned callback"),
        crate_name: "demo".into(),
        metadata: None,
        domain,
    };
    let references = targets
        .into_iter()
        .enumerate()
        .map(|(ordinal, target)| {
            let role = match &target {
                SemanticTarget::CompilerContext { .. } => "compiler_context",
                SemanticTarget::EffectiveCfg { .. } => "effective_cfg",
                SemanticTarget::TargetFeature { .. } => "target_feature",
                SemanticTarget::TestHarnessEntry { .. } => "test_harness_entry",
                SemanticTarget::TestHarnessDescriptor { .. } => "test_harness_descriptor",
                _ => unreachable!(),
            };
            SemanticReference {
                ordinal: ordinal as u64,
                owner_index: 0,
                hir_local_index: ordinal as u32,
                role: role.into(),
                target,
                location: None,
            }
        })
        .collect::<Vec<_>>();
    let count = references.len() as u64;
    SemanticStreamV1 {
        binding: binding.clone(),
        pages: vec![SemanticPageV1 {
            binding: binding.clone(),
            ordinal: 0,
            definitions: vec![],
            references,
            gaps: vec![],
        }],
        terminal: Some(SemanticTerminalV1 {
            binding,
            stop: TraversalStop::EndOfDomain,
            traversal_events: count,
            visited_definitions: 0,
            visited_references: count,
            unsupported: 0,
            omitted: 0,
            emitted_definitions: 0,
            emitted_references: count,
            emitted_pages: 1,
            source_work_bytes: 0,
            gaps: vec![],
        }),
    }
}
fn cfg(ordinal: u64, name: &str, value: Option<&str>) -> SemanticTarget {
    SemanticTarget::EffectiveCfg {
        cfg: Box::new(EffectiveCfgObservation {
            ordinal,
            name: name.into(),
            value: value.map(str::to_owned),
        }),
    }
}
fn feature(inventory: TargetFeatureInventory, ordinal: u64, name: &str) -> SemanticTarget {
    SemanticTarget::TargetFeature {
        feature: Box::new(TargetFeatureObservation {
            inventory,
            ordinal,
            name: name.into(),
        }),
    }
}
#[test]
fn exact_context_inventory_roundtrips_without_cfg_reconstruction() {
    let value = stream(
        SemanticDomain::LocalHirWithCompilerContext,
        vec![
            context(2, 1, 2),
            cfg(0, "debug_assertions", None),
            cfg(1, "feature", Some("")),
            feature(TargetFeatureInventory::Stable, 0, "sse2"),
            feature(TargetFeatureInventory::IncludingUnstable, 0, "sse2"),
            feature(
                TargetFeatureInventory::IncludingUnstable,
                1,
                "internal-feature",
            ),
        ],
    );
    value.validate().unwrap();
    assert_eq!(
        SemanticStreamV1::from_json(&serde_json::to_vec(&value).unwrap()).unwrap(),
        value
    );
}
#[test]
fn omitted_context_rows_need_an_explicit_gap_or_interruption() {
    let mut value = stream(
        SemanticDomain::LocalHirWithCompilerContext,
        vec![context(1, 0, 0)],
    );
    assert!(value.validate().is_err());
    value
        .terminal
        .as_mut()
        .unwrap()
        .gaps
        .push(SemanticGap::CompilerContextUnsupportedValue);
    value.validate().unwrap();
    value.terminal.as_mut().unwrap().gaps.clear();
    value.terminal.as_mut().unwrap().stop = TraversalStop::OutputLimit;
    value
        .terminal
        .as_mut()
        .unwrap()
        .gaps
        .push(SemanticGap::OutputLimit);
    value.validate().unwrap();
}
#[test]
fn opted_context_without_header_cannot_claim_end_of_domain() {
    let mut value = stream(SemanticDomain::LocalHirWithCompilerContext, vec![]);
    assert!(value.validate().is_err());
    value
        .terminal
        .as_mut()
        .unwrap()
        .gaps
        .push(SemanticGap::CompilerContextUnavailable);
    value.validate().unwrap();
}
#[test]
fn duplicate_cfg_and_noncontiguous_ordinals_are_rejected() {
    let value = stream(
        SemanticDomain::LocalHirWithCompilerContext,
        vec![context(2, 0, 0), cfg(0, "x", None), cfg(1, "x", None)],
    );
    assert!(value.validate().is_err());
    let value = stream(
        SemanticDomain::LocalHirWithCompilerContext,
        vec![context(1, 0, 0), cfg(1, "x", None)],
    );
    assert!(value.validate().is_err());
}
#[test]
fn stable_feature_must_belong_to_actual_all_feature_inventory() {
    let value = stream(
        SemanticDomain::LocalHirWithCompilerContext,
        vec![
            context(0, 1, 1),
            feature(TargetFeatureInventory::Stable, 0, "stable"),
            feature(TargetFeatureInventory::IncludingUnstable, 0, "other"),
        ],
    );
    assert!(value.validate().is_err());
}
#[test]
fn duplicate_feature_and_context_headers_are_rejected() {
    assert!(
        stream(
            SemanticDomain::LocalHirWithCompilerContext,
            vec![context(0, 0, 0), context(0, 0, 0)]
        )
        .validate()
        .is_err()
    );
    assert!(
        stream(
            SemanticDomain::LocalHirWithCompilerContext,
            vec![
                context(0, 0, 2),
                feature(TargetFeatureInventory::IncludingUnstable, 0, "x"),
                feature(TargetFeatureInventory::IncludingUnstable, 1, "x")
            ]
        )
        .validate()
        .is_err()
    );
}
#[test]
fn successor_rows_cannot_enter_legacy_domain_or_use_hir_role() {
    assert!(
        stream(SemanticDomain::LocalHir, vec![context(0, 0, 0)])
            .validate()
            .is_err()
    );
    let mut value = stream(
        SemanticDomain::LocalHirWithCompilerContext,
        vec![context(0, 0, 0)],
    );
    value.pages[0].references[0].role = "call".into();
    assert!(value.validate().is_err());
}
#[test]
fn bounded_context_strings_and_inventory_counts_reject_excess() {
    let mut value = CompilerContextObservation {
        provenance: CompilerContextProvenance::RustcSessionAfterAnalysis,
        rustc_version: "version".into(),
        target_llvm: "target".into(),
        target_arch: "arch".into(),
        cfg_entries: 0,
        stable_target_feature_entries: 0,
        all_target_feature_entries: 0,
    };
    value.cfg_entries = MAX_TRAVERSAL_WORK + 1;
    assert!(value.validate().is_err());
    value.cfg_entries = 0;
    value.target_llvm = "x".repeat(MAX_CONTEXT_TEXT + 1);
    assert!(value.validate().is_err());
    assert!(
        EffectiveCfgObservation {
            ordinal: 0,
            name: "a\0b".into(),
            value: None
        }
        .validate()
        .is_err()
    );
}
#[test]
fn ordered_harness_retains_all_policy_and_function_fields() {
    let value = stream(
        SemanticDomain::LocalHirWithTestHarness,
        vec![
            context(0, 0, 0),
            SemanticTarget::TestHarnessEntry {
                entry: Box::new(header(2)),
            },
            SemanticTarget::TestHarnessDescriptor {
                descriptor: Box::new(descriptor("a", 0)),
            },
            SemanticTarget::TestHarnessDescriptor {
                descriptor: Box::new(descriptor("b", 1)),
            },
        ],
    );
    value.validate().unwrap();
    let decoded = SemanticStreamV1::from_json(&serde_json::to_vec(&value).unwrap()).unwrap();
    assert_eq!(value, decoded);
    let SemanticTarget::TestHarnessDescriptor { descriptor } =
        &decoded.pages[0].references[2].target
    else {
        panic!()
    };
    assert!(descriptor.ignore && !descriptor.compile_fail && !descriptor.no_run);
    assert_eq!(descriptor.ignore_message.as_deref(), Some("reason"));
    assert_eq!(
        descriptor.should_panic,
        TestPanicExpectation::Message {
            value: "expected".into()
        }
    );
    assert_ne!(
        descriptor.function.def_path_hash,
        descriptor.closure.def_path_hash
    );
}
#[test]
fn harness_missing_table_rows_need_typed_gap() {
    let mut value = stream(
        SemanticDomain::LocalHirWithTestHarness,
        vec![
            context(0, 0, 0),
            SemanticTarget::TestHarnessEntry {
                entry: Box::new(header(1)),
            },
        ],
    );
    assert!(value.validate().is_err());
    value
        .terminal
        .as_mut()
        .unwrap()
        .gaps
        .push(SemanticGap::TestHarnessUnsupportedDescriptor);
    value.validate().unwrap();
}
#[test]
fn unavailable_and_custom_harness_are_preserved_as_partial() {
    for gap in [
        SemanticGap::TestHarnessUnavailable,
        SemanticGap::TestHarnessCustomRunner,
    ] {
        let mut value = stream(
            SemanticDomain::LocalHirWithTestHarness,
            vec![context(0, 0, 0)],
        );
        value.terminal.as_mut().unwrap().gaps.push(gap);
        value.validate().unwrap();
    }
}
#[test]
fn empty_generated_table_is_distinct_from_missing_harness() {
    stream(
        SemanticDomain::LocalHirWithTestHarness,
        vec![
            context(0, 0, 0),
            SemanticTarget::TestHarnessEntry {
                entry: Box::new(header(0)),
            },
        ],
    )
    .validate()
    .unwrap();
    assert!(
        stream(
            SemanticDomain::LocalHirWithTestHarness,
            vec![context(0, 0, 0)]
        )
        .validate()
        .is_err()
    );
}
#[test]
fn harness_foreign_type_and_duplicate_constant_are_rejected() {
    let mut second = descriptor("b", 1);
    second.constant = descriptor("a", 0).constant;
    assert!(
        stream(
            SemanticDomain::LocalHirWithTestHarness,
            vec![
                context(0, 0, 0),
                SemanticTarget::TestHarnessEntry {
                    entry: Box::new(header(2))
                },
                SemanticTarget::TestHarnessDescriptor {
                    descriptor: Box::new(descriptor("a", 0))
                },
                SemanticTarget::TestHarnessDescriptor {
                    descriptor: Box::new(second)
                }
            ]
        )
        .validate()
        .is_err()
    );
    let mut value = descriptor("a", 0);
    value.descriptor_type = identity(false, 40);
    assert!(
        stream(
            SemanticDomain::LocalHirWithTestHarness,
            vec![
                context(0, 0, 0),
                SemanticTarget::TestHarnessEntry {
                    entry: Box::new(header(1))
                },
                SemanticTarget::TestHarnessDescriptor {
                    descriptor: Box::new(value)
                }
            ]
        )
        .validate()
        .is_err()
    );
}
#[test]
fn harness_order_and_ordinal_are_actual_table_constraints() {
    assert!(
        stream(
            SemanticDomain::LocalHirWithTestHarness,
            vec![
                context(0, 0, 0),
                SemanticTarget::TestHarnessEntry {
                    entry: Box::new(header(2))
                },
                SemanticTarget::TestHarnessDescriptor {
                    descriptor: Box::new(descriptor("b", 0))
                },
                SemanticTarget::TestHarnessDescriptor {
                    descriptor: Box::new(descriptor("a", 1))
                }
            ]
        )
        .validate()
        .is_err()
    );
    assert!(
        stream(
            SemanticDomain::LocalHirWithTestHarness,
            vec![
                context(0, 0, 0),
                SemanticTarget::TestHarnessEntry {
                    entry: Box::new(header(1))
                },
                SemanticTarget::TestHarnessDescriptor {
                    descriptor: Box::new(descriptor("a", 1))
                }
            ]
        )
        .validate()
        .is_err()
    );
}
#[test]
fn used_sysroot_member_paths_and_kinds_are_bounded() {
    let mut value = header(0);
    value.test_crate.members[0].relative = "../libtest.rlib".into();
    assert!(value.validate().is_err());
    value.test_crate.members[0].relative = "lib/libtest.rlib".into();
    value
        .test_crate
        .members
        .push(value.test_crate.members[0].clone());
    assert!(value.validate().is_err());
}
#[test]
fn foreign_wrapper_identity_and_reversed_source_location_reject() {
    let mut value = descriptor("a", 0);
    value.assertion_wrapper = identity(true, 22);
    assert!(value.validate().is_err());
    value = descriptor("a", 0);
    value.end_line = 0;
    assert!(value.validate().is_err());
}
#[test]
fn observation_unknown_fields_and_oversized_page_are_rejected() {
    let mut raw = serde_json::to_value(header(0)).unwrap();
    raw["complete"] = true.into();
    assert!(serde_json::from_value::<TestHarnessEntryObservation>(raw).is_err());
    let mut value = descriptor("a", 0);
    value.name = "x".repeat(MAX_HARNESS_TEXT);
    value.ignore_message = Some("x".repeat(MAX_HARNESS_TEXT));
    value.source_file = "x".repeat(MAX_HARNESS_TEXT);
    value.should_panic = TestPanicExpectation::Message {
        value: "x".repeat(MAX_HARNESS_TEXT),
    };
    for identity in [
        &mut value.constant,
        &mut value.descriptor_type,
        &mut value.closure,
        &mut value.function,
        &mut value.assertion_wrapper,
        &mut value.name_constructor,
        &mut value.function_constructor,
        &mut value.panic_variant,
        &mut value.test_type_variant,
    ] {
        identity.compiler_path = "x".repeat(1024);
    }
    assert!(
        stream(
            SemanticDomain::LocalHirWithTestHarness,
            vec![
                context(0, 0, 0),
                SemanticTarget::TestHarnessEntry {
                    entry: Box::new(header(1))
                },
                SemanticTarget::TestHarnessDescriptor {
                    descriptor: Box::new(value)
                }
            ]
        )
        .validate()
        .is_err()
    );
}

#[test]
fn boxed_successors_preserve_the_original_page_element_capacity() {
    #[allow(dead_code)]
    enum OriginalTarget {
        Definition {
            crate_name: String,
            definition_index: u32,
            compiler_path: String,
        },
        LocalBinding {
            owner_index: u32,
            local_index: u32,
        },
        Builtin {
            name: String,
        },
    }
    assert_eq!(
        std::mem::size_of::<OriginalTarget>(),
        std::mem::size_of::<SemanticTarget>()
    );
    assert_eq!(MAX_PAGE_REFERENCES, 64);
    assert_eq!(MAX_PAGE_BYTES, 24 * 1024);
    assert_eq!(MAX_STREAM_BYTES, 8 * 1024 * 1024);
}
#[test]
fn descriptor_policy_fields_are_observed_without_assumed_defaults() {
    let mut value = descriptor("policy", 0);
    value.compile_fail = true;
    value.no_run = true;
    value.kind = TestDescriptorKind::Bench;
    value.ignore = false;
    value.ignore_message = None;
    value.should_panic = TestPanicExpectation::No;
    value.test_type = CompilerTestType::Integration;
    value.validate().unwrap();
    let raw = serde_json::to_vec(&value).unwrap();
    let decoded: TestDescriptorObservation = serde_json::from_slice(&raw).unwrap();
    assert_eq!(decoded, value);
    assert!(decoded.compile_fail && decoded.no_run);
    assert_eq!(decoded.kind, TestDescriptorKind::Bench);
}
