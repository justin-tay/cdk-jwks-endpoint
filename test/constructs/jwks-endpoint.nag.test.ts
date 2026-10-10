import { App, Stack, Validations } from 'aws-cdk-lib';
import { InterfaceVpcEndpoint, InterfaceVpcEndpointAwsService, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Key } from 'aws-cdk-lib/aws-kms';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { AwsSolutionsChecks } from 'cdk-nag';
import { JwksEndpoint, JwksExposure, JwksSource, type JwksEndpointProps } from '../../src/constructs';

/** A VPC whose own findings (e.g. no flow logs) are out of scope for these tests. */
function vpcWithoutFindings(stack: Stack): Vpc {
  const vpc = new Vpc(stack, 'Vpc');
  Validations.of(vpc).acknowledge({ id: 'AwsSolutions::AwsSolutions-VPC7', reason: 'Test VPC' });
  return vpc;
}

function sources(stack: Stack): JwksSource[] {
  return [
    // The secret's rotation is cdk-jwks-secret's concern, not this construct's.
    JwksSource.fromSecret(
      (() => {
        const secret = new Secret(stack, 'Secret');
        Validations.of(secret).acknowledge({
          id: 'AwsSolutions::AwsSolutions-SMG4',
          reason: 'The secret belongs to cdk-jwks-secret, which rotates it.',
        });
        return secret;
      })(),
    ),
    JwksSource.fromParameter('/app/enc-jwks'),
  ];
}

test.each([
  ['the default Function URL', () => ({})],
  [
    'a customer managed key for the parameter',
    (stack: Stack) => ({
      sources: [
        JwksSource.fromParameter('/app/enc-jwks', {
          encryptionKey: new Key(stack, 'Key', { enableKeyRotation: true }),
        }),
      ],
    }),
  ],
  ['CloudFront', () => ({ exposure: JwksExposure.cloudFront() })],
  ['an HTTP API', () => ({ exposure: JwksExposure.httpApi() })],
  ['a REST API', () => ({ exposure: JwksExposure.restApi() })],
  [
    'a private REST API',
    (stack: Stack) => {
      const vpcEndpoint = new InterfaceVpcEndpoint(stack, 'ExecuteApi', {
        vpc: vpcWithoutFindings(stack),
        service: InterfaceVpcEndpointAwsService.APIGATEWAY,
      });
      // The consumer's endpoint, not this construct's.
      Validations.of(vpcEndpoint).acknowledge({
        id: 'AwsSolutions::AwsSolutions-EC23',
        reason: 'Test endpoint',
      });
      return { exposure: JwksExposure.privateRestApi({ vpcEndpoints: [vpcEndpoint] }) };
    },
  ],
  ['the Lambda in a VPC', (stack: Stack) => ({ lambdaProps: { vpc: vpcWithoutFindings(stack) } })],
] as const)('passes the AWS Solutions cdk-nag checks with %s', (_name, props) => {
  const app = new App();
  const stack = new Stack(app, 'NagStack');
  const extra = props(stack) as Partial<JwksEndpointProps>;
  new JwksEndpoint(stack, 'Endpoint', { sources: sources(stack), ...extra });
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  expect(() => app.synth()).not.toThrow();
});
