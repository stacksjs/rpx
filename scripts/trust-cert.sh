#!/bin/bash

# Helper script to trust RPX SSL certificates
# This script detects the OS and provides instructions for trusting certificates

# Colors for better readability
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}===== RPX Certificate Trust Helper =====${NC}"

# Get the user's home directory
HOME_DIR=$(echo ~)
SSL_DIR="$HOME_DIR/.stacks/ssl"

# Check if the SSL directory exists
if [ ! -d "$SSL_DIR" ]; then
  echo -e "${RED}Error: SSL directory not found at $SSL_DIR${NC}"
  echo -e "Have you run ${YELLOW}rpx start${NC} at least once to generate certificates?"
  exit 1
fi

# Find all certificate files
echo -e "${GREEN}Found these certificates:${NC}"
CERTS=$(find "$SSL_DIR" -name "*.crt" -not -name "*.ca.crt")
CA_CERTS=$(find "$SSL_DIR" -name "*.ca.crt")

# List available certificates
if [ -z "$CERTS" ] && [ -z "$CA_CERTS" ]; then
  echo -e "${RED}No certificates found in $SSL_DIR${NC}"
  echo -e "Please run ${YELLOW}rpx start${NC} first to generate certificates"
  exit 1
fi

# Print found certificates
echo -e "${YELLOW}Server Certificates:${NC}"
for cert in $CERTS; do
  subject=$(openssl x509 -noout -subject -in "$cert" | sed 's/^subject=//g')
  expiry=$(openssl x509 -noout -enddate -in "$cert" | sed 's/^notAfter=//g')
  echo -e "- ${GREEN}$(basename "$cert")${NC}"
  echo -e "  ${BLUE}Subject:${NC} $subject"
  echo -e "  ${BLUE}Expires:${NC} $expiry"
done

echo -e "\n${YELLOW}CA Certificates:${NC}"
for cert in $CA_CERTS; do
  subject=$(openssl x509 -noout -subject -in "$cert" | sed 's/^subject=//g')
  expiry=$(openssl x509 -noout -enddate -in "$cert" | sed 's/^notAfter=//g')
  echo -e "- ${GREEN}$(basename "$cert")${NC}"
  echo -e "  ${BLUE}Subject:${NC} $subject"
  echo -e "  ${BLUE}Expires:${NC} $expiry"
done

# Detect OS and provide appropriate instructions
OS=$(uname -s)
echo -e "\n${BLUE}===== Certificate Trust Instructions for $OS =====${NC}"

case "$OS" in
  Darwin*)
    # macOS
    echo -e "${YELLOW}To trust these certificates on macOS:${NC}"
    echo -e "1. For each certificate, run:"
    echo -e "   ${GREEN}sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain <certificate_path>${NC}"
    echo
    echo -e "   For example:"
    for cert in $CA_CERTS; do
      echo -e "   ${GREEN}sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain $cert${NC}"
    done
    echo
    echo -e "2. Or open each certificate file in Keychain Access:"
    for cert in $CA_CERTS; do
      echo -e "   ${GREEN}open $cert${NC}"
    done
    echo
    echo -e "3. In Keychain Access, find the certificate, double-click it"
    echo -e "4. Expand the 'Trust' section"
    echo -e "5. Set 'When using this certificate' to 'Always Trust'"
    echo -e "6. Close the window (you'll need to enter your password)"
    ;;

  Linux*)
    # Linux
    echo -e "${YELLOW}To trust these certificates on Linux:${NC}"
    echo -e "For Ubuntu/Debian-based systems:"
    echo -e "1. Copy the CA certificate to the trusted certificates directory:"
    for cert in $CA_CERTS; do
      echo -e "   ${GREEN}sudo cp $cert /usr/local/share/ca-certificates/$(basename $cert)${NC}"
    done
    echo -e "2. Update the CA certificates:"
    echo -e "   ${GREEN}sudo update-ca-certificates${NC}"
    echo
    echo -e "For Fedora/RHEL-based systems:"
    echo -e "1. Copy the CA certificate to the trust anchors directory:"
    for cert in $CA_CERTS; do
      echo -e "   ${GREEN}sudo cp $cert /etc/pki/ca-trust/source/anchors/$(basename $cert)${NC}"
    done
    echo -e "2. Update the CA trust store:"
    echo -e "   ${GREEN}sudo update-ca-trust extract${NC}"
    ;;

  MINGW*|CYGWIN*|MSYS*)
    # Windows
    echo -e "${YELLOW}To trust these certificates on Windows:${NC}"
    echo -e "1. Run Command Prompt as Administrator"
    echo -e "2. For each certificate, run:"
    for cert in $CA_CERTS; do
      winpath=$(echo $cert | sed 's/\//\\/g')
      echo -e "   ${GREEN}certutil -addstore -f \"ROOT\" \"$winpath\"${NC}"
    done
    ;;

  *)
    echo -e "${RED}Unsupported OS: $OS${NC}"
    echo -e "Please manually add the certificates to your system trust store."
    ;;
esac

echo -e "\n${BLUE}===== Browser Workaround =====${NC}"
echo -e "${YELLOW}If you're still experiencing certificate warnings:${NC}"
echo -e "1. For Chrome/Edge, you can type ${GREEN}thisisunsafe${NC} directly on the certificate warning page"
echo -e "   (you won't see what you're typing, but it will bypass the warning)"
echo -e "2. For Firefox, click 'Advanced' and then 'Accept the Risk and Continue'"
echo -e "3. For Safari, click 'Show Details', then 'visit this website' and confirm 'Visit Website'"

echo -e "\n${BLUE}===== After Trusting Certificates =====${NC}"
echo -e "1. ${YELLOW}Restart your browser${NC} for the changes to take effect"
echo -e "2. Clear your browser cache if you're still having issues"

echo -e "\n${GREEN}Happy coding with RPX!${NC}"