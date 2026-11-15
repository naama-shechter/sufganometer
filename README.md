# סופגנומטר 🍩

אפליקציית Ionic/Angular + Capacitor שמתחברת למד הצעדים המובנה של הטלפון
ומראה כמה צעדים נשארו עד שמותר סופגנייה חדשה.

## קבלת APK בלי Android Studio (דרך GitHub Actions)

### אפשרות א' – עם git (מומלץ)

1. ב-GitHub יוצרים repo חדש וריק בשם `sufganometer`, **בלי** README.
2. בתיקייה הזאת מריצים:
   ```bash
   git remote add origin https://github.com/<USERNAME>/sufganometer.git
   git push -u origin main
   ```
3. ב-repo נכנסים ללשונית **Actions**. הבנייה "Build APK" מתחילה לבד ולוקחת בערך 5–8 דקות.
4. בסיום נכנסים לריצה, ולמטה תחת **Artifacts** מורידים את `sufganometer-apk` (קובץ zip עם `app-debug.apk` בפנים).

### אפשרות ב' – בלי git, דרך האתר

1. יוצרים repo חדש ב-GitHub ובוחרים **uploading an existing file**.
2. גוררים את כל התוכן של התיקייה (בלי `node_modules`, אם קיימת) ולוחצים Commit.
3. בודקים שהקובץ `.github/workflows/build-apk.yml` עלה. תיקיות שמתחילות בנקודה לפעמים לא עולות בגרירה.
   אם הוא חסר: **Add file → Create new file**, כותבים בשם הקובץ `.github/workflows/build-apk.yml`
   ומדביקים את התוכן שלו מה-zip.
4. ממשיכים משלב 3 באפשרות א'.

## התקנה על הטלפון (אנדרואיד)

1. מעבירים את `app-debug.apk` לטלפון (מייל לעצמך, Drive, או הורדה ישירה מ-GitHub בטלפון) ופותחים אותו.
2. אם מופיעה הודעה על "מקורות לא ידועים", מאשרים התקנה מהאפליקציה שממנה פתחת את הקובץ.
   ה-APK חתום במפתח debug, ולכן Play Protect עשוי להזהיר. זה צפוי לאפליקציה שבנית בעצמך.
3. פותחים את סופגנומטר → **חבר למד הצעדים** → מאשרים "פעילות גופנית".
4. לוחצים **אכלתי** ויוצאים להליכה.

> באנדרואיד נספרים צעדים רק כשהאפליקציה פתוחה. ספירה ברקע תגיע בשלב הבא, עם Health Connect.

## פיתוח מקומי

```bash
npm install
npm start            # דפדפן – מצב הדמיה עם "הדמיית הליכה"
npx ng build && npx cap sync android && npx cap open android   # Android Studio
```

## מבנה

```
src/app/sufganometer/
  donut-calc.ts            לוגיקת "חוב הסופגניות"
  pedometer.service.ts     חיבור לחיישן (@capgo/capacitor-pedometer), הרשאות, שמירה מקומית
  sufganometer.page.*      המסך
.github/workflows/build-apk.yml   בניית APK אוטומטית בכל push
```
