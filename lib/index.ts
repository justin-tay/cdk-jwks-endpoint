// import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export interface CdkJwksEndpointProps {
  // Define construct properties here
}

export class CdkJwksEndpoint extends Construct {

  constructor(scope: Construct, id: string, props: CdkJwksEndpointProps = {}) {
    super(scope, id);

    // Define construct contents here

    // example resource
    // const queue = new sqs.Queue(this, 'CdkJwksEndpointQueue', {
    //   visibilityTimeout: cdk.Duration.seconds(300)
    // });
  }
}
