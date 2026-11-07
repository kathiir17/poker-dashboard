# Supabase → Firestore migration (one-off)

1. One-time setup (installs the Firebase admin library into `migration/.venv`, ignored by git):

       cd ~/code/poker-dashboard
       python3 -m venv migration/.venv
       migration/.venv/bin/pip install firebase-admin

2. Check the inputs without touching Firebase:

       python3 migration/migrate.py --dry-run

3. Migrate and verify:

       migration/.venv/bin/python migration/migrate.py

4. Re-check later at any time (read-only):

       migration/.venv/bin/python migration/migrate.py --verify-only

The admin key is read from `~/code/secrets/poker-admin-key.json` and never copied or printed.
