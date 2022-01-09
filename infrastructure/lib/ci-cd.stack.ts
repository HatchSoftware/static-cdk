import {SecretValue, Stack, StackProps} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import {Artifact, Pipeline} from 'aws-cdk-lib/aws-codepipeline';
import {CodeBuildAction, GitHubSourceAction} from 'aws-cdk-lib/aws-codepipeline-actions';
import {BuildSpec, LinuxBuildImage, PipelineProject} from 'aws-cdk-lib/aws-codebuild';
import {Effect, PolicyStatement} from 'aws-cdk-lib/aws-iam';
import {Subscription, SubscriptionProtocol, Topic} from 'aws-cdk-lib/aws-sns';
import {SnsTopic} from 'aws-cdk-lib/aws-events-targets';
import {identifyResource} from './config-util';

export interface CiCdProps extends StackProps {
  readonly resourcePrefix: string;
  readonly distributionId: string;
  readonly bucket: string;
  readonly repo: string;
  readonly repoOwner: string;
  readonly repoBranch: string;
  readonly githubTokenSecretId: string;
  readonly buildAlertEmail: string;
}

/**
 * Infrastructure that creates a CI/CD pipeline to deploy a static site to an S3 bucket.
 * The pipeline checks out the source code from a GitHub repository, builds it, deploys it to the S3 bucket and invalidates the CloudFront distribution.
 */
export class CiCdStack extends Stack {
  constructor(parent: Construct, id: string, props: CiCdProps) {
    super(parent, id, props);

    // Create the source action
    const github_token = SecretValue.secretsManager(props.githubTokenSecretId, {jsonField: 'github-token'});
    const sourceOutput = new Artifact('SourceOutput');
    const sourceAction = new GitHubSourceAction({
      actionName: 'SOURCE',
      owner: props.repoOwner,
      repo: props.repo,
      branch: props.repoBranch,
      oauthToken: github_token,
      output: sourceOutput
    });

    // Create the build action
    const webBuildProject = this.createBuildProject(props.resourcePrefix, props.distributionId, props.bucket, props.buildAlertEmail, props.env!.account!);
    const buildAction = new CodeBuildAction({
      actionName: 'BUILD_DEPLOY',
      project: webBuildProject,
      input: sourceOutput,
    });

    // Create the pipeline
    const pipelineName = identifyResource(props.resourcePrefix, 'pipeline');
    new Pipeline(this, pipelineName, {
      pipelineName: pipelineName,
      stages: [
        {
          stageName: 'Source',
          actions: [sourceAction],
        },
        {
          stageName: 'Build',
          actions: [buildAction],
        }
      ]
    });
  }

  private createBuildProject(resourcePrefix: string, distributionId: string, staticWebsiteBucket: string, buildAlertEmail: string, account: string) {
    const buildProject = new PipelineProject(this, identifyResource(resourcePrefix, 'build'), {
      buildSpec: BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': {
              nodejs: 'latest'
            },
            commands: [
              'npm install',
            ],
          },
          build: {
            commands: [
              'npm run build',
            ],
          },
          post_build: {
            commands: [
              `aws s3 sync "dist" "s3://${staticWebsiteBucket}" --delete`,
              `aws cloudfront create-invalidation --distribution-id ${distributionId} --paths "/*"`
            ]
          }
        }
      }),
      environment: {
        buildImage: LinuxBuildImage.STANDARD_5_0,
      },
    });

    const codeBuildS3ListObjectsPolicy = new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['s3:GetObject','s3:GetBucketLocation','s3:ListBucket','s3:PutObject','s3:DeleteObject','s3:PutObjectAcl'],
      resources: [`arn:aws:s3:::${staticWebsiteBucket}`,`arn:aws:s3:::${staticWebsiteBucket}/*`],
    });
    buildProject.role?.addToPrincipalPolicy(codeBuildS3ListObjectsPolicy);
    const codeBuildCreateInvalidationPolicy = new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['cloudfront:CreateInvalidation'],
      resources: [`arn:aws:cloudfront::${account}:distribution/${distributionId}`],
    });
    buildProject.role?.addToPrincipalPolicy(codeBuildCreateInvalidationPolicy);

    // Add alert notifications on build failure
    const alertsTopic = new Topic(this, identifyResource(resourcePrefix, 'notifications'), {
      topicName: identifyResource(resourcePrefix, 'notifications'),
      displayName: `${resourcePrefix} pipeline failures`,
    });

    // Subscribe to these alerts using email
    new Subscription(this, identifyResource(resourcePrefix, 'notifications-subscription'), {
      protocol: SubscriptionProtocol.EMAIL,
      endpoint: buildAlertEmail,
      topic: alertsTopic
    });

    buildProject.onBuildFailed(identifyResource(resourcePrefix, 'build-failed'), {target: new SnsTopic(alertsTopic)});

    return buildProject;
  }
}
