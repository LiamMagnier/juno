import Foundation
import XCTest
import JunoCodeCore
import JunoCodeRuntime
import JunoDesignSystem
@testable import JunoCodeUI

/// The model-failover resolver must come from the real model catalog, not a
/// hardcoded provider map. These tests pin the selection rules that keep a
/// production run alive without inventing a model id the catalog never had.
final class CatalogFallbackResolverTests: XCTestCase {

    private func option(
        _ modelID: String,
        providerID: String,
        capabilities: [JunoModelCapability]
    ) -> ModelOption {
        ModelOption(
            modelID: modelID,
            displayName: modelID,
            catalog: JunoModelDescriptor(
                id: modelID,
                providerID: providerID,
                providerName: providerID,
                displayName: modelID,
                capabilities: capabilities
            )
        )
    }

    func testPrefersToolCapableModelFromDifferentProvider() async {
        let resolver = CatalogFallbackResolver(availableModels: [
            option("anthropic:claude-sonnet-5", providerID: "anthropic", capabilities: [.tools]),
            option("openai:gpt-5.4-mini", providerID: "openai", capabilities: [.tools]),
            option("qwen:qwen3.8-max", providerID: "qwen", capabilities: []),
        ])
        let fallback = await resolver.resolveFallback(for: "anthropic:claude-sonnet-5")
        XCTAssertEqual(fallback, "openai:gpt-5.4-mini")
    }

    func testSkipsNonToolModelsWhileToolModelExists() async {
        let resolver = CatalogFallbackResolver(availableModels: [
            option("google:gemini-3-pro", providerID: "google", capabilities: [.tools]),
            option("openai:gpt-4o", providerID: "openai", capabilities: []),
            option("anthropic:claude-sonnet-5", providerID: "anthropic", capabilities: [.tools]),
        ])
        let fallback = await resolver.resolveFallback(for: "google:gemini-3-pro")
        XCTAssertEqual(fallback, "anthropic:claude-sonnet-5")
    }

    func testFallsBackToAnyDifferentProviderWhenNoToolModelExists() async {
        let resolver = CatalogFallbackResolver(availableModels: [
            option("openai:gpt-4o", providerID: "openai", capabilities: []),
            option("anthropic:claude-haiku", providerID: "anthropic", capabilities: []),
        ])
        let fallback = await resolver.resolveFallback(for: "openai:gpt-4o")
        XCTAssertEqual(fallback, "anthropic:claude-haiku")
    }

    func testFallsBackWithinSameProviderAsLastResort() async {
        let resolver = CatalogFallbackResolver(availableModels: [
            option("anthropic:claude-opus-4-8", providerID: "anthropic", capabilities: [.tools]),
            option("anthropic:claude-sonnet-5", providerID: "anthropic", capabilities: [.tools]),
        ])
        let fallback = await resolver.resolveFallback(for: "anthropic:claude-opus-4-8")
        XCTAssertEqual(fallback, "anthropic:claude-sonnet-5")
    }

    func testNeverReturnsTheCurrentModel() async {
        let resolver = CatalogFallbackResolver(availableModels: [
            option("only:model", providerID: "only", capabilities: [.tools]),
        ])
        let fallback = await resolver.resolveFallback(for: "only:model")
        XCTAssertNil(fallback)
    }

    func testReturnsNilWhenCatalogIsEmpty() async {
        let resolver = CatalogFallbackResolver(availableModels: [])
        let fallback = await resolver.resolveFallback(for: "anthropic:claude-sonnet-5")
        XCTAssertNil(fallback)
    }

    func testFlatModelIDTreatsItselfAsItsOwnProvider() async {
        let resolver = CatalogFallbackResolver(availableModels: [
            ModelOption(modelID: "flat-one", displayName: "Flat One"),
            ModelOption(modelID: "flat-two", displayName: "Flat Two"),
        ])
        // Without catalog metadata both ids are their own provider, so the
        // "different provider" rule must still separate them.
        let fallback = await resolver.resolveFallback(for: "flat-one")
        XCTAssertEqual(fallback, "flat-two")
    }

    func testCurrentModelNotInCatalogStillRoutesByProviderPrefix() async {
        let resolver = CatalogFallbackResolver(availableModels: [
            option("anthropic:claude-sonnet-5", providerID: "anthropic", capabilities: [.tools]),
            option("openai:gpt-5.4", providerID: "openai", capabilities: [.tools]),
        ])
        // The running model id predates the catalog refresh; the resolver must
        // not confuse "unknown id" with "same provider".
        let fallback = await resolver.resolveFallback(for: "anthropic:claude-opus-old")
        XCTAssertEqual(fallback, "openai:gpt-5.4")
    }
}