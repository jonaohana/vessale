#!/bin/bash

# CloudWatch Agent Setup Script for Ubuntu
# Run this on your AWS EC2 instance

set -e

echo "=== CloudWatch Agent Installation for Vessel Printer Server ==="
echo ""

# Check if running on EC2
if ! curl -s -m 5 http://169.254.169.254/latest/meta-data/instance-id > /dev/null 2>&1; then
    echo "Warning: This doesn't appear to be an EC2 instance."
    echo "CloudWatch Agent will still install but may not work properly."
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Download CloudWatch Agent
echo "Downloading CloudWatch Agent..."
wget -q https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb

# Install CloudWatch Agent
echo "Installing CloudWatch Agent..."
sudo dpkg -i -E ./amazon-cloudwatch-agent.deb
rm amazon-cloudwatch-agent.deb

# Create configuration directory
sudo mkdir -p /opt/aws/amazon-cloudwatch-agent/etc/

# Create configuration file
echo "Creating CloudWatch Agent configuration..."
sudo tee /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json > /dev/null << 'EOF'
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/printer/printer.log",
            "log_group_name": "/aws/ec2/vessel-printer",
            "log_stream_name": "{instance_id}/application",
            "timezone": "UTC",
            "timestamp_format": "%Y-%m-%d %H:%M:%S"
          },
          {
            "file_path": "/var/log/printer/printer-error.log",
            "log_group_name": "/aws/ec2/vessel-printer",
            "log_stream_name": "{instance_id}/errors",
            "timezone": "UTC"
          },
          {
            "file_path": "/var/log/syslog",
            "log_group_name": "/aws/ec2/vessel-printer",
            "log_stream_name": "{instance_id}/syslog",
            "timezone": "UTC"
          }
        ]
      }
    }
  },
  "metrics": {
    "namespace": "VesselPrinter",
    "metrics_collected": {
      "cpu": {
        "measurement": [
          {"name": "cpu_usage_idle", "rename": "CPU_IDLE", "unit": "Percent"},
          {"name": "cpu_usage_iowait", "rename": "CPU_IOWAIT", "unit": "Percent"}
        ],
        "totalcpu": false,
        "metrics_collection_interval": 60
      },
      "disk": {
        "measurement": [
          {"name": "used_percent", "rename": "DISK_USED", "unit": "Percent"}
        ],
        "metrics_collection_interval": 60,
        "resources": ["*"]
      },
      "mem": {
        "measurement": [
          {"name": "mem_used_percent", "rename": "MEM_USED", "unit": "Percent"}
        ],
        "metrics_collection_interval": 60
      }
    }
  }
}
EOF

# Check IAM role
echo ""
echo "Checking IAM role..."
if curl -s -m 5 http://169.254.169.254/latest/meta-data/iam/info | grep -q "InstanceProfileArn"; then
    echo "✓ IAM role is attached to this instance"
else
    echo "✗ Warning: No IAM role attached to this instance!"
    echo ""
    echo "You need to attach an IAM role with CloudWatchAgentServerPolicy."
    echo "See CLOUDWATCH.md for instructions."
    echo ""
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Start CloudWatch Agent
echo ""
echo "Starting CloudWatch Agent..."
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config \
  -m ec2 \
  -s \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json

# Enable on boot
echo "Enabling CloudWatch Agent on boot..."
sudo systemctl enable amazon-cloudwatch-agent

# Check status
echo ""
echo "CloudWatch Agent status:"
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a query \
  -m ec2 \
  -s

echo ""
echo "=== Setup Complete! ==="
echo ""
echo "Your logs will be sent to CloudWatch Logs under:"
echo "  Log Group: /aws/ec2/vessel-printer"
echo ""
echo "View logs in AWS Console:"
echo "  https://console.aws.amazon.com/cloudwatch/home#logsV2:log-groups/log-group/\$252Faws\$252Fec2\$252Fvessel-printer"
echo ""
echo "Useful commands:"
echo "  sudo systemctl status amazon-cloudwatch-agent"
echo "  sudo systemctl restart amazon-cloudwatch-agent"
echo "  aws logs tail /aws/ec2/vessel-printer --follow"
echo ""
