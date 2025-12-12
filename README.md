# vessale

  sudo systemctl status printer    # Check service status
  sudo systemctl restart printer   # Restart the service
  sudo systemctl stop printer      # Stop the service
  sudo systemctl start printer     # Start the service
  sudo journalctl -u printer -f    # View live logs
  tail -f /var/log/printer/printer.log  # View application logs