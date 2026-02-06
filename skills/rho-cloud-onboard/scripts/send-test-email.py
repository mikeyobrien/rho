#!/usr/bin/env python3
"""Send a test email to an agent's rhobot.dev address.

Usage: python3 send-test-email.py <handle> [subject] [body]

Uses Gmail SMTP with an app password. Requires:
  GMAIL_USER=you@gmail.com
  GMAIL_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx

Generate an app password at: https://myaccount.google.com/apppasswords
"""

import os
import sys
import smtplib
from email.mime.text import MIMEText

def main():
    if len(sys.argv) < 2:
        print("Usage: send-test-email.py <handle> [subject] [body]")
        sys.exit(1)

    handle = sys.argv[1]
    subject = sys.argv[2] if len(sys.argv) > 2 else "Test from demo"
    body = sys.argv[3] if len(sys.argv) > 3 else "This is a test email sent during the Rho Cloud demo."

    gmail_user = os.environ.get("GMAIL_USER")
    gmail_pass = os.environ.get("GMAIL_APP_PASSWORD")

    if not gmail_user or not gmail_pass:
        print("ERROR: Set GMAIL_USER and GMAIL_APP_PASSWORD environment variables")
        print("Generate an app password at: https://myaccount.google.com/apppasswords")
        sys.exit(1)

    to_addr = f"{handle}@rhobot.dev"

    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = gmail_user
    msg["To"] = to_addr

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(gmail_user, gmail_pass)
            server.sendmail(gmail_user, [to_addr], msg.as_string())
        print(f"Sent to {to_addr}: {subject}")
    except Exception as e:
        print(f"ERROR: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
