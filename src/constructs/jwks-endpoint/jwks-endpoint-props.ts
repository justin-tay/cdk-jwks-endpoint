import type { Duration } from 'aws-cdk-lib';
import type { FunctionProps } from 'aws-cdk-lib/aws-lambda';
import type { LogGroupProps } from 'aws-cdk-lib/aws-logs';
import type { JwksExposure } from './jwks-exposure';
import type { JwksSource } from './jwks-source';

/** Props for `JwksEndpoint`. */
export interface JwksEndpointProps {
  /**
   * Where the JWKS are stored, e.g. `JwksSource.fromSecret(jwksSecret.secret)`
   * for `cdk-jwks-secret` and `JwksSource.fromParameter(jwksParameter.parameterName)`
   * for `cdk-jwks-parameter`. The public keys of all of them are served in one
   * JWKS, in this order; a `kid` that appears twice is served once.
   *
   * If any source cannot be read the endpoint answers `503`, rather than
   * serving a JWKS that lacks keys.
   */
  readonly sources: JwksSource[];

  /**
   * How the endpoint is reached.
   *
   * @default JwksExposure.functionUrl(), which is free
   */
  readonly exposure?: JwksExposure;

  /**
   * The path the JWKS is served at, and the only path that answers. Letters,
   * digits and `_ . - ~ /`.
   *
   * @default '/.well-known/jwks.json'
   */
  readonly path?: string;

  /**
   * How long the Lambda caches each source, and the `Cache-Control` max-age of
   * the response. 0 disables both. It delays the visibility of a rotation by
   * up to this long, so it should be a small fraction of the rotation
   * interval. A JWKS with no keys is never cached.
   *
   * @default Duration.minutes(5)
   */
  readonly cacheTtl?: Duration;

  /**
   * Overrides for the Lambda. In a VPC, the subnets need a route to Secrets
   * Manager and Systems Manager, through VPC endpoints or NAT.
   *
   * @default not in a VPC, 128 MB memory
   */
  readonly lambdaProps?: Pick<FunctionProps, 'memorySize' | 'vpc' | 'vpcSubnets' | 'securityGroups'>;

  /**
   * Overrides for the Lambda's log group, which holds the
   * [ECS logs](docs/logging.md).
   *
   * @default `RetentionDays.ONE_YEAR`, no customer managed key, and `RemovalPolicy.RETAIN`
   */
  readonly logGroupProps?: Pick<LogGroupProps, 'retention' | 'removalPolicy' | 'encryptionKey'>;

  /**
   * Log one ECS record for every request. Failures to read a source are
   * logged either way.
   *
   * @default true
   */
  readonly logRequests?: boolean;

  /**
   * Include the client's `source.ip` and `user_agent.original` in the request
   * records. Set to `false` where logging IP addresses is not allowed.
   *
   * @default true
   */
  readonly logClientDetails?: boolean;
}
