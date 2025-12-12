# Deployment Guide for Ubuntu AWS Server

This guide explains how to set up the Vessel Printer Server to automatically start on boot and restart on crashes.

## Prerequisites

- Ubuntu AWS EC2 instance
- Node.js installed on the server
- Application files deployed to `/home/ubuntu/printer/`

## Setup Steps

### 1. Deploy Your Application

```bash
# On your local machine, copy files to server
scp -r ./* ubuntu@your-server-ip:/home/ubuntu/printer/

# Or use git
ssh ubuntu@your-server-ip
cd /home/ubuntu
git clone <your-repo-url> printer
cd printer
npm install --production
```

### 2. Install the Systemd Service

```bash
# SSH into your server
ssh ubuntu@your-server-ip

# Navigate to your application directory
cd /home/ubuntu/printer

# Make the setup script executable
chmod +x setup-service.sh

# Run the setup script
./setup-service.sh
```

### 3. Verify the Service is Running

```bash
sudo systemctl status printer
```

You should see output showing the service is "active (running)".

## Service Management Commands

```bash
# Check service status
sudo systemctl status printer

# Start the service
sudo systemctl start printer

# Stop the service
sudo systemctl stop printer

# Restart the service
sudo systemctl restart printer

# View live logs
sudo journalctl -u printer -f

# View application logs
tail -f /var/log/printer/printer.log

# View error logs
tail -f /var/log/printer/printer-error.log

# Disable auto-start on boot
sudo systemctl disable printer

# Enable auto-start on boot
sudo systemctl enable printer
```

## Configuration

### Adjust Working Directory

If your application is not in `/home/ubuntu/printer`, edit the `printer.service` file:

```bash
sudo nano /etc/systemd/system/printer.service
```

Update these lines:
```
WorkingDirectory=/path/to/your/app
ExecStart=/usr/bin/node /path/to/your/app/index.js
```

Then reload and restart:
```bash
sudo systemctl daemon-reload
sudo systemctl restart printer
```

### Change User

If you want to run the service as a different user, edit the service file:

```
User=your-username
```

Make sure to also update log directory permissions:
```bash
sudo chown your-username:your-username /var/log/printer
```

### Add Environment Variables

To add environment variables, edit the service file and add more `Environment=` lines:

```
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=API_KEY=your-api-key
```

## Troubleshooting

### Service won't start

1. Check the logs:
```bash
sudo journalctl -u printer -n 50
```

2. Verify Node.js path:
```bash
which node
```

If it's not `/usr/bin/node`, update the `ExecStart` path in the service file.

3. Check file permissions:
```bash
ls -la /home/ubuntu/printer/index.js
```

### Service crashes immediately

Check error logs:
```bash
sudo journalctl -u printer -n 100
tail -f /var/log/printer/printer-error.log
```

### Port already in use

Check what's using the port:
```bash
sudo lsof -i :3000
```

Kill the process or change your application's port.

## Security Considerations

1. **Firewall**: Ensure your AWS Security Group allows inbound traffic on your application's port
2. **HTTPS**: Consider using a reverse proxy like Nginx with SSL/TLS
3. **Updates**: Keep your system and Node.js updated
4. **Logs**: Set up log rotation to prevent disk space issues

## Log Rotation

Create a logrotate configuration:

```bash
sudo nano /etc/logrotate.d/printer
```

Add:
```
/var/log/printer/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 0644 ubuntu ubuntu
    postrotate
        systemctl reload printer > /dev/null 2>&1 || true
    endscript
}
```

## Additional Notes

- The service will automatically restart if it crashes (RestartSec=10 means wait 10 seconds before restarting)
- Logs are appended to `/var/log/printer/printer.log` and `/var/log/printer/printer-error.log`
- The service starts after the network is available
- The service is enabled to start automatically on system boot
