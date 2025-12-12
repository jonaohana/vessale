#!/bin/bash

# Setup script for the Vessel Printer Server systemd service
# Run this on your Ubuntu AWS server

set -e

echo "Setting up Vessel Printer Server as a systemd service..."

# Create log directory
sudo mkdir -p /var/log/printer
sudo chown ubuntu:ubuntu /var/log/printer

# Copy service file to systemd directory
sudo cp printer.service /etc/systemd/system/

# Reload systemd to recognize the new service
sudo systemctl daemon-reload

# Enable the service to start on boot
sudo systemctl enable printer.service

# Start the service
sudo systemctl start printer.service

# Show service status
sudo systemctl status printer.service

echo ""
echo "✓ Service installed and started!"
echo ""
echo "Useful commands:"
echo "  sudo systemctl status printer    # Check service status"
echo "  sudo systemctl restart printer   # Restart the service"
echo "  sudo systemctl stop printer      # Stop the service"
echo "  sudo systemctl start printer     # Start the service"
echo "  sudo journalctl -u printer -f    # View live logs"
echo "  tail -f /var/log/printer/printer.log  # View application logs"
