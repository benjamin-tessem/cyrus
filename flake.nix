{
  description = "Cyrus (benjamin-tessem fork), packaged for Nix";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in
    {
      packages.${system} = {
        cyrus = pkgs.callPackage ./nix/package.nix { };
        default = self.packages.${system}.cyrus;
      };
    };
}
