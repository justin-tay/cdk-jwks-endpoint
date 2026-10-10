# Contributing

## Development

Requires Node.js 24.

```
src/
  constructs/                   the constructs (package entry point)
  assets/lambda/handlers/       the endpoint Lambda, bundled by esbuild
  shared/jwks/                  the JWKS validation and publishing rules, no AWS dependencies
bin/                            the example app (not published)
scripts/                        the end-to-end test against AWS
test/                           mirrors src/ and bin/
docs/                           construct reference and guides
```

- `npm run clean`: delete `lib/` (runs automatically before `npm pack` / `npm publish`)
- `npm run build`: compile to `lib/` and bundle the Lambda into
  `lib/assets/lambda/handlers/endpoint/`
- `npm run typecheck`: type-check sources, the example, scripts and tests
- `npm run lint` / `lint:fix`: lint with [Oxlint](https://oxc.rs/docs/guide/usage/linter), including type-aware rules
- `npm run format` / `format:check`: format with [Oxfmt](https://oxc.rs/docs/guide/usage/formatter)
- `npm test`: bundle the Lambda, then run the tests with coverage (minimums in
  `jest.config.js`), including [cdk-nag](https://github.com/cdklabs/cdk-nag) checks.
  Tests use fake AWS credentials and never reach AWS.
- `npm run test:aws`: deploy the example app to the AWS account and region of
  your current credentials (`-- --exposure=httpApi` and so on; a public
  exposure only), check what the endpoint serves once the secret and the
  parameter hold keys, check that its log group holds only bare ECS access
  records and no key material, then destroy the stack (`-- --keep` to keep
  it). Costs a few cents; CloudFront takes several minutes. The credentials
  need `logs:FilterLogEvents`, `secretsmanager:GetSecretValue` and
  `ssm:GetParameter` as well as permission to deploy.
- `npm run cdk:synth` / `cdk:diff` / `cdk:deploy` / `cdk:destroy`: build, then
  run the CDK CLI on the example app

CI runs the type check, lint, format check, tests and build on every push and
pull request.

The example imports the package by name (`cdk-jwks-endpoint`), as a consumer
would. During development `paths` in `tsconfig.json` (honoured by `tsx` and
esbuild) and `moduleNameMapper` in `jest.config.js` resolve it to `src/`. The
example and the tests use the published `cdk-jwks-secret` and
`cdk-jwks-parameter` as development dependencies, so the fixtures are made by
the code that writes the JWKS in production; the package itself depends on
neither.

`src/shared/jwks` is a deliberate copy of the subset of `cdk-jwks-secret`'s
JWKS code that reading needs (parse, validate, publishing rule). If either
sibling changes the key layout or the publishing rule, the tests here fail,
because they check the copy against JWKS the sibling produced.

## Logging

The Lambda logs through `src/assets/lambda/logger.ts`, and nothing else
writes to stdout or calls `console`. The events are a closed catalogue
(`EVENTS`), documented in [docs/logging.md](docs/logging.md):

- To log something new, add an ECS-aligned entry to `EVENTS` and to the event
  index and event reference in `docs/logging.md`, instead of writing an ad hoc
  message. Add a field to the schema tables when you add one.
- Never log key material, a secret or parameter value, or an error message that might
  echo one. `errorFields` logs a message only for the error classes it allows;
  add a class there only if this package writes its message.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `docs:`, `chore:`, `feat!:` for breaking changes …). They
determine the next version and the changelog, so pick the type that describes
the change for users of the package.

## Releasing

This section is for maintainers.

[release-please](https://github.com/googleapis/release-please) keeps a release
pull request open with the next version and `CHANGELOG.md`; merging it tags the
release, and the release workflow publishes to npm with
[trusted publishing](https://docs.npmjs.com/trusted-publishers) and provenance.
Versions stay `0.x` until the API is stable. In `0.x`, both `feat:` and
breaking changes bump the minor version, and `fix:` bumps the patch version.

### One-time setup

- The first release has to be published by hand (`npm publish`), because npm
  can only configure a trusted publisher for a package that already exists.
  Then, on npmjs.com, add this repository's `release.yml` workflow and `npm`
  environment as the package's trusted publisher.
- Create the `npm` environment in the repository's settings, optionally with
  required reviewers so each publish needs approval.
- Enable private vulnerability reporting in the repository's security
  settings, which [SECURITY.md](SECURITY.md) points to.
