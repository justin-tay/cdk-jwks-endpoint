import type { Duration, StackProps } from 'aws-cdk-lib';
import type { JwkAlgorithm } from 'cdk-jwks-secret';

/** How the example reaches the endpoint; each is a `JwksExposure` factory. */
export type ExampleExposure = 'functionUrl' | 'cloudFront' | 'httpApi' | 'restApi' | 'privateRestApi';

export interface AppStackProps extends StackProps {
  /**
   * The front door. `functionUrl` is free; `privateRestApi` needs
   * `vpcEndpointId`.
   *
   * @default 'functionUrl'
   */
  readonly exposure?: ExampleExposure;

  /**
   * The id of an existing `execute-api` interface VPC endpoint that may call
   * the private REST API. Required for `privateRestApi`; the example never
   * creates one, since an endpoint costs money while it exists.
   */
  readonly vpcEndpointId?: string;

  /**
   * The id of an existing VPC to run the endpoint Lambda in, in its private
   * subnets with egress. The subnets need a route to Secrets Manager and
   * Systems Manager (VPC endpoints or NAT). Needs an explicit `env`.
   *
   * @default not in a VPC
   */
  readonly lambdaVpcId?: string;

  /**
   * Where the signing keys are kept. `parameter` (`cdk-jwks-parameter`) is
   * free; `secret` (`cdk-jwks-secret`) costs $0.40 a month, and shows an
   * endpoint reading both backends at once. The encryption keys are always in
   * a parameter.
   *
   * @default 'parameter'
   */
  readonly sigSource?: 'parameter' | 'secret';

  /** The algorithm of the signing keys. @default ES256 */
  readonly sigAlgorithm?: JwkAlgorithm;

  /** The algorithm of the encryption keys. @default ECDH-ES+A128KW */
  readonly encAlgorithm?: JwkAlgorithm;

  /**
   * How long the endpoint caches the sources, also the Cache-Control max-age.
   * The example doesn't cache by default, so a rotation shows up immediately;
   * a real endpoint would cache for a few minutes.
   *
   * @default Duration.seconds(0)
   */
  readonly cacheTtl?: Duration;
}
