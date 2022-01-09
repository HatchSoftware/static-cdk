import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import {Aws, CfnOutput, RemovalPolicy, Stack, StackProps} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import {identifyResource} from './config-util';

export interface StaticSiteProps extends StackProps {
    readonly resourcePrefix: string;
    readonly hostedZoneName: string;
    readonly domainName: string;
    readonly includeWWW: boolean;
    readonly siteSourcePath: string;
    readonly staticSiteBucketNameOutputId: string;
    readonly staticSiteDistributionIdOutputId: string;
}

/**
 * Infrastructure that hosts a static site on an S3 bucket.
 * The site enforces HTTPS, using a CloudFront distribution, Route53 alias record, and ACM certificate.
 */
export class StaticSiteStack extends Stack {
    constructor(parent: Construct, id: string, props: StaticSiteProps) {
        super(parent, id, props);

        const zone = route53.HostedZone.fromLookup(this, identifyResource(props.resourcePrefix,'hosted-zone'), {domainName: props.hostedZoneName});
        const siteDomain = props.domainName;
        const fullSiteDomain = `www.${siteDomain}`;
        const cloudfrontOAI = new cloudfront.OriginAccessIdentity(this, identifyResource(props.resourcePrefix,'cloudfront-OAI'), {
            comment: `OAI for ${id}`
        });

        // Create an s3 bucket for the static content
        const siteBucket = new s3.Bucket(this, identifyResource(props.resourcePrefix,'site-bucket'), {
            bucketName: siteDomain,
            websiteIndexDocument: 'index.html',
            websiteErrorDocument: 'error.html',
            publicReadAccess: false,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,

            // !!! CAUTION: setting this to true will destroy the entire S3 bucket in case of failure / destruction (unless it is not empty)
            removalPolicy: RemovalPolicy.DESTROY, // NOT recommended for production code

            // !!! CAUTION: setting this to true will clear the entire S3 bucket in case of failure / destruction
            autoDeleteObjects: true, // NOT recommended for production code
        });

        // Grant access to cloudfront
        siteBucket.addToResourcePolicy(new iam.PolicyStatement({
            actions: ['s3:GetObject'],
            resources: [siteBucket.arnForObjects('*')],
            principals: [new iam.CanonicalUserPrincipal(cloudfrontOAI.cloudFrontOriginAccessIdentityS3CanonicalUserId)]
        }));
        new CfnOutput(this, props.staticSiteBucketNameOutputId, {value: siteBucket.bucketName,exportName: props.staticSiteBucketNameOutputId});

        // Create TLS certificate + automatic DNS validation
        const certificateArn = new acm.DnsValidatedCertificate(this, identifyResource(props.resourcePrefix,'site-certificate'), {
            domainName: siteDomain,
            hostedZone: zone,
            region: 'us-east-1', // Cloudfront only checks this region for certificates.
            subjectAlternativeNames: props.includeWWW ? [fullSiteDomain] : []
        }).certificateArn;

        // Create a CloudFront viewer certificate enforcing usage of HTTPS & TLS v1.2
        const viewerCertificate = cloudfront.ViewerCertificate.fromAcmCertificate({
                certificateArn: certificateArn,
                env: {
                    region: Aws.REGION,
                    account: Aws.ACCOUNT_ID
                },
                node: this.node,
                stack: this,
                metricDaysToExpiry: () =>
                    new cloudwatch.Metric({
                        namespace: 'TLS Viewer Certificate Validity',
                        metricName: 'TLS Viewer Certificate Expired',
                    }),
                applyRemovalPolicy: (policy: RemovalPolicy) => {
                }
            },
            {
                sslMethod: cloudfront.SSLMethod.SNI,
                securityPolicy: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
                aliases: props.includeWWW ? [siteDomain, fullSiteDomain] : [siteDomain],
            })

        // Set up the CloudFront distribution
        const distribution = new cloudfront.CloudFrontWebDistribution(this, identifyResource(props.resourcePrefix,'site-distribution'), {
            viewerCertificate,
            originConfigs: [
                {
                    s3OriginSource: {
                        s3BucketSource: siteBucket,
                        originAccessIdentity: cloudfrontOAI
                    },
                    behaviors: [{
                        isDefaultBehavior: true,
                        compress: true,
                        allowedMethods: cloudfront.CloudFrontAllowedMethods.GET_HEAD_OPTIONS,
                    }],
                }
            ]
        });
        new CfnOutput(this, props.staticSiteDistributionIdOutputId, {value: distribution.distributionId,exportName: props.staticSiteDistributionIdOutputId});

        // Set up Route53 aliases records for the CloudFront distribution
        new route53.ARecord(this, identifyResource(props.resourcePrefix,'site-alias-record-01'), {
            recordName: siteDomain,
            target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
            zone
        });

        if(props.includeWWW) {
            new route53.ARecord(this, identifyResource(props.resourcePrefix,'site-alias-record-02'), {
                recordName: fullSiteDomain,
                target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
                zone
            });
        }

        // Deploy site contents to S3 bucket
        new s3deploy.BucketDeployment(this, identifyResource(props.resourcePrefix,'bucket-deployment'), {
            sources: [s3deploy.Source.asset(props.siteSourcePath)],
            destinationBucket: siteBucket,
            distribution,
            distributionPaths: ['/*'],
        });
    }
}
