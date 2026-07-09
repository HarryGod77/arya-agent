# 🎩 Arya Agent — Setup Guide

Pura automation system: class reminders, Meet links, recording delivery, aur social auto-posting. Ye guide follow karo, 30-40 min me chalu ho jayega.

---

## 0) Chalane ka basic

```bash
npm install
cp .env.example .env      # phir .env me apni keys bharo (neeche steps)
npm start
```
Panel khulega: **http://localhost:3000** — `.env` wala `ADMIN_PASSWORD` daalke enter.

> **Hosting:** local pe test karo, phir Railway/Render pe deploy (24x7 chalna chahiye scheduler ke liye). Server timezone **Asia/Kolkata** set karna (`TZ=Asia/Kolkata`).

---

## 1) Google (Calendar + Meet + Drive + Gmail + YouTube) — sabse zaroori

1. [console.cloud.google.com](https://console.cloud.google.com) → naya project.
2. **APIs enable karo:** Calendar API, Drive API, Gmail API, YouTube Data API v3.
3. **OAuth consent screen** setup (External, apni email test user me add karo).
4. **Credentials → OAuth Client ID → Desktop app** banao → `CLIENT_ID` + `CLIENT_SECRET` milega.
5. **Refresh token** nikaalo (ek baar): [OAuth Playground](https://developers.google.com/oauthplayground) →
   - Settings (⚙️) → "Use your own OAuth credentials" → apna id/secret daalo.
   - Left me ye scopes select karo:
     `calendar`, `drive`, `gmail.send`, `youtube.upload`
   - Authorize → Exchange → **refresh_token** copy → `.env` me `GOOGLE_REFRESH_TOKEN`.
6. `.env` me `GOOGLE_SENDER_EMAIL` = jis Gmail se mails jaayenge.
7. Drive me 3 folders banao, unki **folder ID** (URL ke last part) `.env` me daalo:
   - `DRIVE_INBOX_FOLDER_ID` — yahan recordings daaloge.
   - `DRIVE_POST_QUEUE_FOLDER_ID` — social ke liye videos.
   - `DRIVE_POSTED_FOLDER_ID` — posted yahan move ho jaayengi.

---

## 2) Gemini (captions)
[aistudio.google.com](https://aistudio.google.com) → API key → `.env` me `GEMINI_API_KEY`.

---

## 3) Meta (Facebook Page + Instagram)
1. [developers.facebook.com](https://developers.facebook.com) → app banao (Business type).
2. Page ID (`FB_PAGE_ID`) aur **Page Access Token** (`FB_PAGE_ACCESS_TOKEN`) — long-lived token nikaalo.
   Permissions chahiye: `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish`.
3. Instagram **Business/Creator** account Page se connect hona chahiye → `IG_BUSINESS_ACCOUNT_ID`.

> ⚠️ **Reminder:** FB **Page** pe hi post hoga, personal profile pe nahi (API allow hi nahi karta).
> ⚠️ IG/FB-Reel ke liye video ka **public URL** chahiye — code Drive ka public download link use karta hai, but bade videos pe Meta kabhi-kabhi Drive link reject karta hai. Agar issue aaye toh video ko S3/Cloudinary jaisi jagah host karke us URL se post karna (thoda tweak). Ye test karke batana.

---

## 4) WhatsApp
- Pehli baar `npm start` pe terminal me **QR** aayega → phone → WhatsApp → Linked Devices → scan.
- Session `data/wa-auth/` me save ho jata hai (dubara scan nahi).
- Group JID nikalne ke liye: panel → **Run & Tools → Load my groups** → JID copy → batch me daalo.
- **Toggle** (Settings tab): OFF = message tere Note-to-Self pe (safe, tu forward karega) · ON = seedha group me (ban risk).

---

## 5) Use kaise karein
- **Batch banao** (Batches tab): naam + emails + (optional) group JID.
- **Class add karo:** topic + date/time → Meet link auto ban jayega. 24hr pehle reminder khud chala jayega.
- **Recording:** class ke baad video ko `_inbox` folder me is naming se daalo:
  `August_MindReading_10Aug.mp4` → agent khud sahi folder me file karega + link bhej dega.
- **Social:** videos `post_queue` folder me daalo → roz 10 baje (config) auto-post.

---

## ⚠️ Honest status
- **Classes (reminders + recordings):** core solid hai, bas Google creds chahiye.
- **Social + WhatsApp:** code poora hai par **tere live accounts pe test karna zaroori** — Meta APIs environment ke hisaab se nakhre karti hain (token scopes, public URL, IG processing). Ek-ek karke test karenge, jo toote wo fix.

Koi bhi step atke toh bata — us hisse ko saath me debug karenge.
