#!/bin/bash

# Helper script to trust RPX SSL certificates
# This script detects the OS and provides instructions for trusting certificates

# Colors for better readability
RED="\033[ 0;31m"
GREEN="\033[ 0;32m"
YELLOW="\033[ 1;33m"
BLUE="\033[ 0;34m"
NC="\033[ 0m" # No Color

printf "%b===== RPX Certificate Trust Helper =====%b\n" "$BLUE" "$NC"

# Get the user's home directory
HOME_DIR=$(echo ~)
SSL_DIR="$HOME_DIR/.stacks/ssl"

# Check if the SSL directory exists
if [[ ! -d "$SSL_DIR" ]]; then
  printf "%bError: SSL directory not found at %s%b\n" "$RED" "$SSL_DIR" "$NC"
  printf "Have you run %brpx start%b at least once to generate certificates?\n" "$YELLOW" "$NC"
  exit 1
fi

# Find all certificate files
printf "%bFound these certificates:%b\n" "$GREEN" "$NC"
CERTS=$(find "$SSL_DIR" -name "*.crt" -not -name "*.ca.crt")
CA_CERTS=$(find "$SSL_DIR" -name "*.ca.crt")

# List available certificates
if [[ -z "$CERTS" ]] && [[ -z "$CA_CERTS" ]]; then
  printf "%bNo certificates found in %s%b\n" "$RED" "$SSL_DIR" "$NC"
  printf "Please run %brpx start%b first to generate certificates\n" "$YELLOW" "$NC"
  exit 1
fi

# Print found certificates
printf "%bServer Certificates:%b\n" "$YELLOW" "$NC"
for cert in $CERTS; do
  subject=$(openssl x509 -noout -subject -in "$cert" | sed 's/^subject=//g')
  expiry=$(openssl x509 -noout -enddate -in "$cert" | sed 's/^notAfter=//g')
  printf "- %b%s%b\n" "$GREEN" "$(basename "$cert")" "$NC"
  printf "  %bSubject:%b %s\n" "$BLUE" "$NC" "$subject"
  printf "  %bExpires:%b %s\n" "$BLUE" "$NC" "$expiry"
done

printf "\n%bCA Certificates:%b\n" "$YELLOW" "$NC"
for cert in $CA_CERTS; do
  subject=$(openssl x509 -noout -subject -in "$cert" | sed 's/^subject=//g')
  expiry=$(openssl x509 -noout -enddate -in "$cert" | sed 's/^notAfter=//g')
  printf "- %b%s%b\n" "$GREEN" "$(basename "$cert")" "$NC"
  printf "  %bSubject:%b %s\n" "$BLUE" "$NC" "$subject"
  printf "  %bExpires:%b %s\n" "$BLUE" "$NC" "$expiry"
done

# Detect OS and provide appropriate instructions
OS=$(uname -s)
printf "\n%b===== Certificate Trust Instructions for %s =====%b\n" "$BLUE" "$OS" "$NC"

case "$OS" in
  Darwin*)
    # macOS
    printf "%bTo trust these certificates on macOS:%b\n" "$YELLOW" "$NC"
    printf "1. For each certificate, run:\n"
    printf "   %bsudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain <certificate_path>%b\n" "$GREEN" "$NC"
    printf "\n"
    printf "   For example:\n"
    for cert in "$CA_CERTS"; do
      printf "   %bsudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain %s%b\n" "$GREEN" "$cert" "$NC"
    done
    printf "\n"
    printf "2. Or open each certificate file in Keychain Access:\n"
    for cert in "$CA_CERTS"; do
      printf "   %bopen %s%b\n" "$GREEN" "$cert" "$NC"
    done
    printf "\n"
    printf "3. In Keychain Access, find the certificate, double-click it\n"
    printf "4. Expand the 'Trust' section\n"
    printf "5. Set 'When using this certificate' to 'Always Trust'\n"
    printf "6. Close the window (you'll need to enter your password)\n"
  ;;

  Linux*)
    # Linux
    printf "%bTo trust these certificates on Linux:%b\n" "$YELLOW" "$NC"
    printf "For Ubuntu/Debian-based systems:\n"
    printf "1. Copy the CA certificate to the trusted certificates directory:\n"
    for cert in "$CA_CERTS"; do
      printf "   %bsudo cp %s /usr/local/share/ca-certificates/%s%b\n" "$GREEN" "$cert" "$(basename "$cert")" "$NC"
    done
    printf "2. Update the CA certificates:\n"
    printf "   %bsudo update-ca-certificates%b\n" "$GREEN" "$NC"
    printf "\n"
    printf "For Fedora/RHEL-based systems:\n"
    printf "1. Copy the CA certificate to the trust anchors directory:\n"
    for cert in "$CA_CERTS"; do
      printf "   %bsudo cp %s /etc/pki/ca-trust/source/anchors/%s%b\n" "$GREEN" "$cert" "$(basename "$cert")" "$NC"
    done
    printf "2. Update the CA trust store:\n"
    printf "   %bsudo update-ca-trust extract%b\n" "$GREEN" "$NC"
  ;;

  MINGW*|CYGWIN*|MSYS*)
    # Windows
    printf "%bTo trust these certificates on Windows:%b\n" "$YELLOW" "$NC"
    printf "1. Run Command Prompt as Administrator\n"
    printf "2. For each certificate, run:\n"
    for cert in "$CA_CERTS"; do
      winpath=$(echo "$cert" | sed 's/\//\\/g')
      printf "   %bcertutil -addstore -f \"ROOT\" \"%s\"%b\n" "$GREEN" "$winpath" "$NC"
    done
  ;;

  *)
    printf "%bUnsupported OS: %s%b\n" "$RED" "$OS" "$NC"
    printf "Please manually add the certificates to your system trust store.\n"
  ;;
esac

printf "\n%b===== Browser Workaround =====%b\n" "$BLUE" "$NC"
printf "%bIf you're still experiencing certificate warnings:%b\n" "$YELLOW" "$NC"
printf "1. For Chrome/Edge, you can type %bthisisunsafe%b directly on the certificate warning page\n" "$GREEN" "$NC"
printf "   (you won't see what you're typing, but it will bypass the warning)\n"
printf "2. For Firefox, click 'Advanced' and then 'Accept the Risk and Continue'\n"
printf "3. For Safari, click 'Show Details', then 'visit this website' and confirm 'Visit Website'\n"

printf "\n%b===== After Trusting Certificates =====%b\n" "$BLUE" "$NC"
printf "1. %bRestart your browser%b for the changes to take effect\n" "$YELLOW" "$NC"
printf "2. Clear your browser cache if you're still having issues\n"

printf "\n%bHappy coding with RPX!%b\n" "$GREEN" "$NC"
