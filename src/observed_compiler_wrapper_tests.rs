//! Real configuration/request producers; these are not compiler execution proof.
use super::*;
use crate::test_support::Workspace;
fn session(workspace: &Workspace) -> Session {
    Session::new(
        workspace.meta.clone(),
        workspace.root.join("target").as_std_path(),
        &[],
    )
    .unwrap()
}
fn callback(workspace: &Workspace, session: &Session) -> CallbackRequest {
    CallbackRequest {
        schema_version: compiler_occurrence::OCCURRENCES_VERSION,
        nonce: "owned-producer".into(),
        command_fingerprint: compiler_occurrence::fingerprint(b"actual ordered command"),
        crate_name: "demo_lib".into(),
        metadata: None,
        source: workspace.root.join("demo/src/lib.rs").into_std_path_buf(),
        source_root: workspace.root.clone().into_std_path_buf(),
        target_root: workspace.root.join("target").into_std_path_buf(),
        output: session.config.directory.join("occurrences-0.json"),
    }
}
#[test]
fn default_config_and_legacy_request_bytes_remain_omitted_successor() {
    let workspace = Workspace::new(&[("demo", "demo_lib")]);
    let mut session = session(&workspace);
    let bytes = fs::read(&session.path).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(value.get("compiler_context").is_none() && value.get("test_harness").is_none());
    assert!(!session.config.compiler_context && !session.config.test_harness);
    session.config.occurrences = true;
    session.enable_semantic_stream().unwrap();
    let callback = callback(&workspace, &session);
    let path = semantic_callback_request(&session.config, &callback, 0).unwrap();
    let request: SemanticRequest = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(request.binding.domain, SemanticDomain::LocalHir);
    assert_eq!(request.binding.nonce, callback.nonce);
}
#[test]
fn optional_context_requires_real_semantic_occurrence_configuration() {
    let workspace = Workspace::new(&[("demo", "demo_lib")]);
    let mut session = session(&workspace);
    let bytes = fs::read(&session.path).unwrap();
    assert!(session.enable_compiler_context_observation().is_err());
    assert_eq!(fs::read(&session.path).unwrap(), bytes);
    session.config.occurrences = true;
    assert!(session.enable_compiler_context_observation().is_err());
    session.enable_semantic_stream().unwrap();
    session.enable_compiler_context_observation().unwrap();
    let actual: Config = serde_json::from_slice(&fs::read(&session.path).unwrap()).unwrap();
    assert!(actual.compiler_context && !actual.test_harness);
    let callback = callback(&workspace, &session);
    let path = observed_semantic_callback_request(&actual, &callback, 0).unwrap();
    let request: SemanticRequest = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(
        request.binding.domain,
        SemanticDomain::LocalHirWithCompilerContext
    );
    assert_eq!(
        request.binding.command_fingerprint,
        callback.command_fingerprint
    );
}
#[test]
fn harness_enrollment_includes_same_context_and_held_request_correlation() {
    let workspace = Workspace::new(&[("demo", "demo_lib")]);
    let mut session = session(&workspace);
    session.config.occurrences = true;
    session.enable_semantic_stream().unwrap();
    session.enable_test_harness_observation().unwrap();
    assert!(session.config.compiler_context && session.config.test_harness);
    let callback = callback(&workspace, &session);
    let path = observed_semantic_callback_request(&session.config, &callback, 0).unwrap();
    let request: SemanticRequest = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        request.binding.domain,
        SemanticDomain::LocalHirWithTestHarness
    );
    assert_eq!(request.binding.nonce, callback.nonce);
    assert_eq!(
        request.output_directory,
        session.config.directory.join("semantic-0")
    );
    assert_eq!(request.budget_directory, session.config.directory);
    #[cfg(target_os = "linux")]
    {
        let occurrence = session.config.directory.join("callback-0.json");
        exclusive_write(&occurrence, &serde_json::to_vec(&callback).unwrap()).unwrap();
        let controls = build_graph::held_callback_control::OwnedSealedControls::from_private_files(
            &occurrence,
            Some(&path),
        )
        .unwrap();
        let mut child = Command::new("actual-driver");
        let _retained = controls.configure_child(&mut child).unwrap();
        assert!(
            child
                .get_envs()
                .any(|(name, value)| name == "BG_DRIVER_SEMANTIC_REQUEST_FD" && value.is_some())
        );
        assert_eq!(
            serde_json::from_slice::<SemanticRequest>(&fs::read(path).unwrap())
                .unwrap()
                .binding,
            request.binding
        );
    }
}
#[test]
fn inconsistent_harness_only_config_is_rejected_without_new_request() {
    let workspace = Workspace::new(&[("demo", "demo_lib")]);
    let mut session = session(&workspace);
    session.config.occurrences = true;
    session.config.semantic_stream = true;
    session.config.test_harness = true;
    assert!(observed_semantic_domain(&session.config).is_err());
    assert!(
        observed_semantic_callback_request(&session.config, &callback(&workspace, &session), 0)
            .is_err()
    );
    assert!(
        !session
            .config
            .directory
            .join("semantic-request-0.json")
            .exists()
    );
}
#[test]
fn repeated_successor_request_cannot_replace_existing_private_control() {
    let workspace = Workspace::new(&[("demo", "demo_lib")]);
    let mut session = session(&workspace);
    session.config.occurrences = true;
    session.enable_semantic_stream().unwrap();
    session.enable_compiler_context_observation().unwrap();
    let callback = callback(&workspace, &session);
    let path = observed_semantic_callback_request(&session.config, &callback, 0).unwrap();
    let original = fs::read(&path).unwrap();
    assert!(observed_semantic_callback_request(&session.config, &callback, 0).is_err());
    assert_eq!(fs::read(path).unwrap(), original);
}
