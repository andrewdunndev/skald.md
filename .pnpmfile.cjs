// typescript-eslint cannot load the TS 7 API; give it the side-by-side TS 6.
function readPackage(pkg) {
  if (pkg.name === 'typescript-eslint' || pkg.name.startsWith('@typescript-eslint/')) {
    delete pkg.peerDependencies?.typescript;
    pkg.dependencies = { ...pkg.dependencies, typescript: 'npm:typescript@6.0.3' };
  }
  return pkg;
}
module.exports = { hooks: { readPackage } };
