========================================
  PAYSLIP SENDER - Setup Instructions
========================================

STEP 1: Install Node.js
------------------------
1. Go to https://nodejs.org
2. Click the LTS button (the green one) to download the installer
3. Run the downloaded .msi file
4. Click Next through the wizard, keep all defaults checked
5. On the "Tools for Native Modules" screen, check the box for
   "Automatically install the necessary tools"
6. Click Install, then Finish

To verify it worked, open Command Prompt and type:
   node -v
   npm -v
Both should print version numbers.


STEP 2: Install Git (for auto-updates)
----------------------------------------
1. Go to https://git-scm.com/download/win
2. Download and run the installer
3. Click Next through the wizard, keep all defaults
4. Click Install, then Finish


STEP 3: Clone the App
-----------------------
1. Open Command Prompt
2. Navigate to where you want the app:
      cd Desktop
3. Run:
      git clone https://github.com/andagrounn/payslip-sender.git
4. Open the payslip-sender folder
5. Double-click PayslipSender.bat
   - First run will install dependencies (takes ~1 minute)
   - The app will open automatically in your browser

For future launches, you can use PayslipSender.vbs instead
for a clean launch with no terminal window.

The app auto-updates from GitHub every time you launch it.


STEP 3: Using the App
----------------------
1. Select how many payslips are on each page (1, 2, 3, or 4)
2. Upload your consolidated payslip PDF
3. Review detected employee names and email addresses
4. Configure SMTP settings (click SMTP Settings in the top right)
5. Click Send Payslips


TIPS
----
- You can right-click PayslipSender.vbs > Create Shortcut
  and move it to your Desktop for easy access
- SMTP settings are saved in your browser so you only
  need to enter them once
- Use Import CSV to bulk-fill email addresses


TROUBLESHOOTING
---------------
- "Node.js is not installed" error:
  Make sure you completed Step 1 and restarted your computer

- App won't open in browser:
  Open your browser manually and go to http://localhost:3000

- Port already in use:
  Close any other Payslip Sender windows and try again

========================================
  Quest Security Services
========================================
