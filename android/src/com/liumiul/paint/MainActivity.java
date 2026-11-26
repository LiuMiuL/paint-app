package com.liumiul.paint;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;

import java.io.OutputStream;

/**
 * 그림판 앱 껍데기.
 * APK 안의 assets(index.html·app.js·styles.css)를 WebView로 띄우고,
 * 웹에서 할 수 없는 일(사진 고르기, 갤러리 저장, 공유)만 이어 준다.
 */
public class MainActivity extends Activity {
    private static final int PICK_FILE = 1;
    private WebView web;
    private ValueCallback<Uri[]> pendingFile;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        // 상태·내비게이션 바를 그림판 바탕색(styles.css --bg)에 맞춘다.
        boolean night = (getResources().getConfiguration().uiMode
            & android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        int bg = night ? 0xFF0F141C : 0xFFEEF1F6;
        getWindow().setStatusBarColor(bg);
        getWindow().setNavigationBarColor(bg);
        if (!night) getWindow().getDecorView().setSystemUiVisibility(
            android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // 화면 테마 설정 기억용
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);         // 갤러리에서 고른 사진 읽기
        s.setSupportZoom(false);

        web.addJavascriptInterface(new Bridge(), "PaintApp");
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (pendingFile != null) pendingFile.onReceiveValue(null);
                pendingFile = cb;
                try {
                    startActivityForResult(params.createIntent(), PICK_FILE);
                    return true;
                } catch (Exception e) {
                    pendingFile = null;
                    return false;
                }
            }
        });

        setContentView(web);
        web.loadUrl("file:///android_asset/index.html");
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != PICK_FILE || pendingFile == null) return;
        pendingFile.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
        pendingFile = null;
    }

    // 뒤로 가기로 실수로 닫아 그림을 잃지 않도록 한 번 묻는다.
    @Override
    public void onBackPressed() {
        new AlertDialog.Builder(this)
            .setMessage("그림판을 닫을까요?\n저장하지 않은 그림은 사라져요.")
            .setPositiveButton("닫기", (d, w) -> finish())
            .setNegativeButton("취소", null)
            .show();
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /** PNG를 갤러리(사진/그림판 폴더)에 저장하고 그 주소를 돌려준다. 실패하면 null. */
    private Uri savePicture(String base64, String name) {
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            ContentValues v = new ContentValues();
            v.put(MediaStore.Images.Media.DISPLAY_NAME, name);
            v.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
            v.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/그림판");
            Uri uri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
            if (uri == null) return null;
            try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                if (out == null) return null;
                out.write(bytes);
            }
            return uri;
        } catch (Exception e) {
            return null;
        }
    }

    /** app.js 에서 window.PaintApp 으로 부르는 기능 */
    private class Bridge {
        @JavascriptInterface
        public boolean savePng(String base64, String name) {
            return savePicture(base64, name) != null;
        }

        @JavascriptInterface
        public boolean sharePng(String base64, String name) {
            Uri uri = savePicture(base64, name);
            if (uri == null) return false;
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("image/png");
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            runOnUiThread(() -> startActivity(Intent.createChooser(send, "그림 공유")));
            return true;
        }
    }
}
