# Cyrus (this fork) as a Nix package: the `cyrus` CLI and everything it
# needs at runtime, built from the pnpm workspace with pinned dependencies.
#
# When pnpm-lock.yaml changes, pnpmDeps.hash must be updated: build once
# with `hash = lib.fakeHash;` and copy the "got:" hash from the error.
{
  lib,
  stdenv,
  nodejs_24,
  pnpm_10,
  fetchPnpmDeps,
  pnpmConfigHook,
  makeWrapper,
}:
stdenv.mkDerivation (finalAttrs: {
  pname = "cyrus";
  version = (lib.importJSON ../apps/cli/package.json).version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.difference (lib.fileset.gitTracked ../.) (
      lib.fileset.unions [
        ../nix
        ../flake.nix
        (lib.fileset.maybeMissing ../flake.lock)
        ../.github
      ]
    );
  };

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    pnpm = pnpm_10;
    fetcherVersion = 3;
    hash = "sha256-TCBvy5vQC5F5fmB/EUizW5AEE5D/vxkmRAAWhrLgJPA=";
  };

  nativeBuildInputs = [
    nodejs_24
    pnpm_10
    pnpmConfigHook
    makeWrapper
  ];

  env.CI = "1";

  buildPhase = ''
    runHook preBuild
    pnpm --filter 'cyrus-ai...' build
    runHook postBuild
  '';

  # The whole built workspace, with node_modules, not a `pnpm deploy`
  # bundle: workspace packages resolve each other through node_modules
  # symlinks, and the prompts and skills they read at runtime sit next to
  # their dist/ output.
  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/cyrus $out/bin
    cp -r . $out/lib/cyrus
    makeWrapper ${lib.getExe nodejs_24} $out/bin/cyrus \
      --add-flags $out/lib/cyrus/apps/cli/dist/src/app.js
    runHook postInstall
  '';

  # Prebuilt binaries under node_modules (the Agent SDK's bundled Claude
  # Code, Codex) are Bun/Rust executables for generic Linux. Patching them
  # can corrupt Bun single-file executables, so they run through nix-ld on
  # the host instead.
  dontPatchELF = true;
  dontStrip = true;

  meta = {
    description = "Linear/GitHub agent orchestrator for Claude Code and Codex (fork)";
    homepage = "https://github.com/benjamin-tessem/cyrus";
    license = lib.licenses.asl20;
    mainProgram = "cyrus";
    platforms = [ "x86_64-linux" ];
  };
})
