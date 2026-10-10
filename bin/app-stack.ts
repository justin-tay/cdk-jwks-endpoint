import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { InterfaceVpcEndpoint, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { JwksParameter } from 'cdk-jwks-parameter';
import { JwksSecret } from 'cdk-jwks-secret';
import { JwksEndpoint, JwksExposure, JwksSource } from 'cdk-jwks-endpoint';
import type { AppStackProps, ExampleExposure } from './app-stack-props';

/**
 * Example of using `JwksEndpoint`: signing keys and encryption keys in rotated
 * SSM parameters (`cdk-jwks-parameter`, free), whose public keys are served
 * from one `jwks_uri`. With `sigSource: 'secret'` the signing keys are in a
 * rotated Secrets Manager secret (`cdk-jwks-secret`, $0.40 a month) instead,
 * so the endpoint reads both backends. The front door is chosen by `exposure`;
 * the default is the free Function URL.
 */
export class AppStack extends Stack {
  /** The signing keys, with `sigSource: 'parameter'` (the default). */
  public readonly sigJwksParameter?: JwksParameter;

  /** The signing keys, with `sigSource: 'secret'`. */
  public readonly sigJwksSecret?: JwksSecret;

  public readonly encJwksParameter: JwksParameter;

  public readonly jwksEndpoint: JwksEndpoint;

  constructor(scope: Construct, id: string, props: AppStackProps = {}) {
    super(scope, id, props);

    // The example cleans up on `cdk destroy`; both constructs retain by default.
    let sigSource: JwksSource;
    if (props.sigSource === 'secret') {
      this.sigJwksSecret = new JwksSecret(this, 'SigJwksSecret', {
        use: 'sig',
        algorithm: props.sigAlgorithm,
        secretProps: { removalPolicy: RemovalPolicy.DESTROY },
        rotationLogGroupProps: { retention: RetentionDays.ONE_WEEK },
      });
      sigSource = JwksSource.fromSecret(this.sigJwksSecret.secret);
    } else {
      this.sigJwksParameter = new JwksParameter(this, 'SigJwksParameter', {
        use: 'sig',
        algorithm: props.sigAlgorithm,
        parameterProps: { removalPolicy: RemovalPolicy.DESTROY },
        rotationLogGroupProps: { retention: RetentionDays.ONE_WEEK },
      });
      sigSource = JwksSource.fromParameter(this.sigJwksParameter.parameterName);
    }
    this.encJwksParameter = new JwksParameter(this, 'EncJwksParameter', {
      use: 'enc',
      algorithm: props.encAlgorithm,
      parameterProps: { removalPolicy: RemovalPolicy.DESTROY },
      rotationLogGroupProps: { retention: RetentionDays.ONE_WEEK },
    });

    this.jwksEndpoint = new JwksEndpoint(this, 'JwksEndpoint', {
      sources: [sigSource, JwksSource.fromParameter(this.encJwksParameter.parameterName)],
      exposure: this.exposure(props.exposure ?? 'functionUrl', props.vpcEndpointId),
      cacheTtl: props.cacheTtl ?? Duration.seconds(0),
      lambdaProps: props.lambdaVpcId
        ? {
            vpc: Vpc.fromLookup(this, 'LambdaVpc', { vpcId: props.lambdaVpcId }),
            vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
          }
        : undefined,
      logGroupProps: { retention: RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY },
    });

    new CfnOutput(this, 'JwksUrl', { value: this.jwksEndpoint.url });
    new CfnOutput(this, 'EndpointLogGroup', { value: this.jwksEndpoint.logGroup.logGroupName });
    if (this.sigJwksSecret) {
      new CfnOutput(this, 'SigSecretArn', { value: this.sigJwksSecret.secret.secretArn });
    }
    if (this.sigJwksParameter) {
      new CfnOutput(this, 'SigParameterName', { value: this.sigJwksParameter.parameterName });
    }
    new CfnOutput(this, 'EncParameterName', { value: this.encJwksParameter.parameterName });
  }

  private exposure(exposure: ExampleExposure, vpcEndpointId: string | undefined): JwksExposure {
    switch (exposure) {
      case 'functionUrl':
        return JwksExposure.functionUrl();
      case 'cloudFront':
        return JwksExposure.cloudFront();
      case 'httpApi':
        return JwksExposure.httpApi();
      case 'restApi':
        return JwksExposure.restApi();
      case 'privateRestApi': {
        if (!vpcEndpointId) {
          throw new Error(
            'exposure privateRestApi needs vpcEndpointId, the id of an execute-api VPC endpoint',
          );
        }
        return JwksExposure.privateRestApi({
          vpcEndpoints: [
            InterfaceVpcEndpoint.fromInterfaceVpcEndpointAttributes(this, 'ExecuteApiEndpoint', {
              vpcEndpointId,
              port: 443,
            }),
          ],
        });
      }
      default:
        throw new Error(`Unknown exposure ${String(exposure)}`);
    }
  }
}
