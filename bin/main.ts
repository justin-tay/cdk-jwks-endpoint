import { App, Duration } from 'aws-cdk-lib';
import type { JwkAlgorithm } from 'cdk-jwks-secret';
import { AppStack } from './app-stack';
import type { ExampleExposure } from './app-stack-props';

const app = new App();

// e.g. npx cdk deploy -c exposure=httpApi -c cacheSeconds=300
// A private REST API needs an existing execute-api VPC endpoint:
//   npx cdk deploy -c exposure=privateRestApi -c vpcEndpointId=vpce-0123456789abcdef0
// the Lambda can run in an existing VPC's private subnets: -c lambdaVpcId=vpc-0123456789abcdef0
// and the signing keys can be in a Secrets Manager secret ($0.40 a month): -c sigSource=secret
const exposure: ExampleExposure | undefined = app.node.tryGetContext('exposure');
const vpcEndpointId: string | undefined = app.node.tryGetContext('vpcEndpointId');
const lambdaVpcId: string | undefined = app.node.tryGetContext('lambdaVpcId');
const sigSource: 'parameter' | 'secret' | undefined = app.node.tryGetContext('sigSource');
const sigAlgorithm: JwkAlgorithm | undefined = app.node.tryGetContext('sigAlgorithm');
const encAlgorithm: JwkAlgorithm | undefined = app.node.tryGetContext('encAlgorithm');
const cacheSeconds: string | undefined = app.node.tryGetContext('cacheSeconds');

new AppStack(app, 'JwksEndpointExampleApp', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  exposure,
  vpcEndpointId,
  lambdaVpcId,
  sigSource,
  sigAlgorithm,
  encAlgorithm,
  cacheTtl: cacheSeconds === undefined ? undefined : Duration.seconds(Number(cacheSeconds)),
});
