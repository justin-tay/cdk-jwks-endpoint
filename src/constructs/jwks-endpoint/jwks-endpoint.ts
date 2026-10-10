import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { Duration, RemovalPolicy, Stack, Validations } from 'aws-cdk-lib';
import type { Distribution } from 'aws-cdk-lib/aws-cloudfront';
import { ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import {
  Architecture,
  Code,
  Function as LambdaFunction,
  LoggingFormat,
  Runtime,
  type FunctionUrl,
} from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import type { RestApi } from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';
import { JwksExposure } from './jwks-exposure';
import type { JwksEndpointProps } from './jwks-endpoint-props';

// src/ and lib/ sit at the same depth, so this resolves to the bundle under
// lib/ both from the compiled construct and from the TypeScript source in tests.
const ENDPOINT_HANDLER_ASSET_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'lib',
  'assets',
  'lambda',
  'handlers',
  'endpoint',
);

const DEFAULT_PATH = '/.well-known/jwks.json';

/** An absolute path of plain segments: nothing a gateway would treat as a variable or a query. */
const PATH_PATTERN = /^\/[A-Za-z0-9_.~-]+(\/[A-Za-z0-9_.~-]+)*$/;

/**
 * Serves the public keys of one or more JWKS, stored in Secrets Manager
 * secrets or SSM parameters, from a `jwks_uri`, through the front door you
 * choose with `exposure`.
 */
export class JwksEndpoint extends Construct {
  /** The Lambda that reads the sources and answers requests. */
  public readonly handler: LambdaFunction;

  /** The Lambda's log group. */
  public readonly logGroup: LogGroup;

  /** The Lambda's execution role. */
  public readonly handlerRole: Role;

  /**
   * The URL of the JWKS. For a private REST API this is the API's
   * `execute-api` URL, which only its VPC endpoints can reach.
   */
  public readonly url: string;

  /** The Function URL, for `JwksExposure.functionUrl()` and `cloudFront()`. */
  public readonly functionUrl?: FunctionUrl;

  /** The distribution, for `JwksExposure.cloudFront()`. */
  public readonly distribution?: Distribution;

  /** The HTTP API, for `JwksExposure.httpApi()`. */
  public readonly httpApi?: HttpApi;

  /** The REST API, for `JwksExposure.restApi()` and `privateRestApi()`. */
  public readonly restApi?: RestApi;

  constructor(scope: Construct, id: string, props: JwksEndpointProps) {
    super(scope, id);

    if (props.sources.length === 0) {
      throw new Error('sources must hold at least one JwksSource');
    }
    const jwksPath = props.path ?? DEFAULT_PATH;
    if (!PATH_PATTERN.test(jwksPath)) {
      throw new Error(
        `path must be an absolute path of letters, digits and _ . - ~ segments, got "${jwksPath}"`,
      );
    }
    const cacheTtl = props.cacheTtl ?? Duration.minutes(5);
    const cacheSeconds = cacheTtl.toSeconds();
    if (!Number.isInteger(cacheSeconds) || cacheSeconds < 0) {
      throw new Error(
        `cacheTtl must be a whole number of seconds, 0 or more, got ${cacheTtl.toHumanString()}`,
      );
    }
    const { lambdaProps = {}, logGroupProps = {} } = props;
    const memorySize = lambdaProps.memorySize ?? 128;
    if (!Number.isInteger(memorySize) || memorySize < 128 || memorySize > 10240) {
      throw new Error(`lambdaProps.memorySize must be an integer from 128 to 10240, got ${memorySize}`);
    }

    if (!existsSync(path.join(ENDPOINT_HANDLER_ASSET_PATH, 'index.mjs'))) {
      throw new Error(
        `Endpoint Lambda bundle not found at ${ENDPOINT_HANDLER_ASSET_PATH}. Run "npm run build:lambda".`,
      );
    }

    this.logGroup = new LogGroup(this, 'HandlerLogGroup', {
      retention: logGroupProps.retention ?? RetentionDays.ONE_YEAR,
      encryptionKey: logGroupProps.encryptionKey,
      removalPolicy: logGroupProps.removalPolicy ?? RemovalPolicy.RETAIN,
    });

    // Instead of AWSLambdaBasicExecutionRole, which may write to any log group,
    // the role may write only to the Lambda's own log group.
    this.handlerRole = new Role(this, 'HandlerRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });
    this.logGroup.grantWrite(this.handlerRole);
    if (lambdaProps.vpc) {
      this.handlerRole.addManagedPolicy(
        ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      );
      Validations.of(this.handlerRole).acknowledge({
        id: 'AwsSolutions::AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole]',
        reason:
          'Lambda needs these network interface permissions to run in a VPC; they do not support resource-level permissions.',
      });
    }
    for (const source of props.sources) {
      source.grantRead(this, this.handlerRole);
    }

    this.handler = new LambdaFunction(this, 'Handler', {
      description: 'Serves the public keys of the JWKS',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      handler: 'index.handler',
      code: Code.fromAsset(ENDPOINT_HANDLER_ASSET_PATH),
      memorySize,
      timeout: Duration.seconds(10),
      environment: {
        JWKS_SOURCES: Stack.of(this).toJsonString(props.sources.map((source) => source.toConfig())),
        JWKS_PATH: jwksPath,
        JWKS_CACHE_SECONDS: String(cacheSeconds),
        JWKS_LOG_REQUESTS: String(props.logRequests ?? true),
        JWKS_LOG_CLIENT_DETAILS: String(props.logClientDetails ?? true),
      },
      logGroup: this.logGroup,
      // The function writes ECS JSON records straight to stdout, which the
      // JSON log format would wrap; see docs/logging.md.
      loggingFormat: LoggingFormat.TEXT,
      role: this.handlerRole,
      vpc: lambdaProps.vpc,
      vpcSubnets: lambdaProps.vpcSubnets,
      securityGroups: lambdaProps.securityGroups,
    });

    const exposure = props.exposure ?? JwksExposure.functionUrl();
    const exposed = exposure.bind(this, this.handler, jwksPath);
    this.url = exposed.url;
    this.functionUrl = exposed.functionUrl;
    this.distribution = exposed.distribution;
    this.httpApi = exposed.httpApi;
    this.restApi = exposed.restApi;
  }
}
