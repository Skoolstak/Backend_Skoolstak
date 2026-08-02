# 🔒 PRODUCTION ENVIRONMENT SETUP GUIDE

## 📋 Pre-Deployment Checklist

### ✅ **Step 1: Verify Local Setup**
```bash
# Run comprehensive sync check
cd server
node run-sync-check.js

# Should show all green ✅
```

---

## 🌐 **Step 2: Set Up Production Environment Variables**

### **Backend (.env for Render.com)**
```env
# Application
PORT=5000
NODE_ENV=production

# Client URL (Update to your production domain)
CLIENT_URL=https://skoolstak.com

# Supabase
SUPABASE_URL=https://gtpixeszbxlkoowuxhbf.supabase.co
SUPABASE_ANON_KEY=<your-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>

# Payment Gateway
PAYSTACK_SECRET_KEY=<your-live-paystack-key>
```

### **Frontend (.env for Vercel/Netlify)**
```env
# Supabase
REACT_APP_SUPABASE_URL=https://gtpixeszbxlkoowuxhbf.supabase.co
REACT_APP_SUPABASE_ANON_KEY=<your-anon-key>

# Backend API (Update to your backend domain)
REACT_APP_API_URL=https://api.skoolstak.com/api
```

⚠️ **CRITICAL:** Never commit `.env` files to git!

---

## 🗄️ **Step 3: Database Setup**

### **Run Migration 006 (If Not Already Applied)**
```sql
-- In Supabase Dashboard → SQL Editor, run:
-- File: supabase/migrations/006_add_ids_photos_password_reset.sql
```

### **Create Storage Buckets**
1. Go to Supabase Dashboard → Storage
2. Create bucket: `student-photos`
   - Public: ✅ Yes
   - File size limit: 2MB
   - Allowed MIME types: `image/jpeg,image/png,image/webp`
3. Create bucket: `staff-photos`
   - Public: ✅ Yes
   - File size limit: 2MB
   - Allowed MIME types: `image/jpeg,image/png,image/webp`

### **Verify RLS Policies**
```sql
-- Check if RLS is enabled on all tables
SELECT schemaname, tablename, rowsecurity 
FROM pg_tables 
WHERE schemaname = 'public' AND rowsecurity = false;

-- Should return empty result (all tables have RLS enabled)
```

---

## 🚀 **Step 4: Deploy Backend (Render.com)**

### **Option A: GitHub Integration (Recommended)**
1. Go to [Render.com](https://render.com)
2. Click "New +" → "Web Service"
3. Connect GitHub repository: `Backend_Skoolstak`
4. Configure:
   - **Name:** skoolstak-backend
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node index.js`
   - **Plan:** Free (or Starter for production)
5. Add Environment Variables (from Step 2)
6. Click "Create Web Service"

### **Option B: Manual Deploy**
```bash
# Install Render CLI
npm install -g @render/cli

# Deploy
cd server
render deploy
```

### **Verify Deployment**
```bash
# Test health endpoint
curl https://your-backend.onrender.com/health

# Should return: {"status":"ok","time":"2026-08-02T..."}
```

---

## 🌍 **Step 5: Deploy Frontend (Vercel)**

### **Option A: Vercel CLI (Recommended)**
```bash
# Install Vercel CLI
npm install -g vercel

# Deploy
cd client
vercel

# Follow prompts, then deploy to production:
vercel --prod
```

### **Option B: GitHub Integration**
1. Go to [Vercel.com](https://vercel.com)
2. Click "Add New" → "Project"
3. Import `Frontend_Skoolstak` repository
4. Configure:
   - **Framework:** Create React App
   - **Build Command:** `npm run build`
   - **Output Directory:** `build`
5. Add Environment Variables (from Step 2)
6. Click "Deploy"

### **Verify Deployment**
1. Visit your production URL
2. Try logging in
3. Test photo upload
4. Test password change

---

## 🔐 **Step 6: Security Hardening**

### **1. Enable HTTPS (Automatic with Render/Vercel)**
- ✅ Render provides automatic HTTPS
- ✅ Vercel provides automatic HTTPS

### **2. Update CORS Settings**
After deployment, verify CORS in `server/index.js`:
```javascript
app.use(cors({
  origin: 'https://skoolstak.com', // Your production URL
  credentials: true,
}));
```

### **3. Enable Supabase Database Backups**
1. Supabase Dashboard → Settings → Database
2. Enable "Daily Backups"
3. Set retention period: 7 days minimum

### **4. Set Up Monitoring**
```bash
# Install error tracking (optional but recommended)
npm install @sentry/node @sentry/react

# Add to server/index.js and client/src/index.js
# Follow Sentry setup guide: https://docs.sentry.io/
```

---

## 🧪 **Step 7: Production Testing**

### **Critical Tests**
```bash
# 1. Authentication
- Register new school admin
- Login with email
- Login with student ID
- Login with teacher ID
- Change password
- Forgot password flow

# 2. Student Management
- Create student (with photo)
- Import students via Excel
- Verify student can log in
- Verify student can change password

# 3. Staff Management
- Create staff (with photo)
- Import staff via Excel
- Verify staff receives invitation email
- Verify staff can log in

# 4. Multi-Tenancy
- Create two schools
- Verify data isolation (School A cannot see School B data)

# 5. File Uploads
- Upload student photo
- Upload staff photo
- Verify photos display correctly
- Verify 2MB size limit works

# 6. Rate Limiting
- Try 25 failed login attempts
- Verify rate limit kicks in after 20 attempts
- Wait 15 minutes and verify access restored
```

---

## 📊 **Step 8: Monitoring & Alerts**

### **Set Up Uptime Monitoring**
1. Create account at [UptimeRobot](https://uptimerobot.com) (free)
2. Add monitor:
   - URL: `https://your-backend.onrender.com/health`
   - Type: HTTP(s)
   - Interval: 5 minutes
3. Add email alerts

### **Monitor Logs**
```bash
# Render.com logs
https://dashboard.render.com → Your Service → Logs

# Supabase logs
https://app.supabase.com → Your Project → Logs
```

---

## 🆘 **Step 9: Disaster Recovery**

### **Database Backup**
```bash
# Export database (Supabase Dashboard)
1. Settings → Database → Export database
2. Download SQL dump
3. Store in secure location (Google Drive, AWS S3)

# Restore database
1. Create new Supabase project (if needed)
2. Settings → Database → Import database
3. Upload SQL dump
```

### **Code Rollback**
```bash
# Revert to previous commit
git log  # Find commit hash
git revert <commit-hash>
git push origin main

# Automatic deploy will trigger
```

---

## ✅ **Step 10: Launch Checklist**

Before announcing to users:
- [ ] Backend deployed and accessible
- [ ] Frontend deployed and accessible
- [ ] Database migration 006 applied
- [ ] Storage buckets created
- [ ] SSL/HTTPS working
- [ ] CORS properly configured
- [ ] Environment variables set (production values)
- [ ] Monitoring enabled
- [ ] Backups enabled
- [ ] All critical tests passed
- [ ] Documentation updated
- [ ] Team trained on production access

---

## 🎉 **You're Ready for Production!**

Your Skoolstak platform is secure, scalable, and ready to serve schools across Ghana.

**Support Contacts:**
- Technical Issues: [your-email@skoolstak.com]
- Emergency Hotline: [your-phone]

**Last Updated:** 2026-08-02
