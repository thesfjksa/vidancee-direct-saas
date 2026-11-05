using System;
using System.Drawing;
using System.Text.RegularExpressions;
using System.Windows.Forms;

internal sealed class PairingForm : Form {
  internal readonly TextBox Address = new TextBox();
  internal readonly TextBox PairCode = new TextBox();
  internal readonly Button PasteCode = new Button();
  internal readonly Button ConnectButton = new Button();
  private readonly Label feedback = new Label();
  internal string BaseUrl;
  internal string Code;

  internal PairingForm() {
    Text = "Connect CMMTools RDP"; ClientSize = new Size(530, 335);
    Font = new Font("Segoe UI", 10); AutoScaleMode = AutoScaleMode.Font;
    FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false;
    StartPosition = FormStartPosition.CenterScreen;
    AddLabel("Pair this RDP with CMMTools", 22, 20, 480, 30, true);
    AddLabel("Copy the code from Admin, then paste it below. You only pair once.", 22, 55, 480, 40, false);
    AddLabel("CMMTools address", 22, 100, 480, 24, false);
    Address.SetBounds(22, 126, 486, 28); Address.Text = "https://cmmtools.site";
    Address.AccessibleName = "CMMTools address"; Controls.Add(Address);
    AddLabel("Pairing code", 22, 165, 480, 24, false);
    PairCode.SetBounds(22, 191, 350, 30); PairCode.Font = new Font("Consolas", 12);
    PairCode.AccessibleName = "Pairing code"; PairCode.MaxLength = 256; Controls.Add(PairCode);
    PasteCode.Text = "Paste code"; PasteCode.SetBounds(382, 190, 126, 32);
    PasteCode.Click += delegate { PasteFromClipboard(); }; Controls.Add(PasteCode);
    feedback.SetBounds(22, 233, 486, 40); feedback.ForeColor = Color.Firebrick;
    feedback.AccessibleName = "Pairing feedback"; Controls.Add(feedback);
    var cancel = new Button(); cancel.Text = "Cancel"; cancel.SetBounds(282, 283, 106, 32);
    cancel.DialogResult = DialogResult.Cancel; Controls.Add(cancel); CancelButton = cancel;
    ConnectButton.Text = "Connect"; ConnectButton.SetBounds(398, 283, 110, 32);
    ConnectButton.Click += delegate { Submit(); }; Controls.Add(ConnectButton); AcceptButton = ConnectButton;
    Shown += delegate { PairCode.Focus(); };
  }
  private void AddLabel(string text, int x, int y, int width, int height, bool heading) {
    var label = new Label(); label.Text = text; label.SetBounds(x, y, width, height);
    if (heading) label.Font = new Font(Font, FontStyle.Bold); Controls.Add(label);
  }
  internal static string NormalizeCode(string value) {
    var matches = Regex.Matches(value ?? "", @"(?<![a-fA-F0-9])[a-fA-F0-9]{24}(?![a-fA-F0-9])");
    return matches.Count == 1 ? matches[0].Value.ToUpperInvariant() : null;
  }
  internal void PasteFromClipboard() {
    try {
      string code = NormalizeCode(Clipboard.GetText());
      if (code == null) { feedback.Text = "Copy the pairing code in Admin first, then click Paste code."; return; }
      PairCode.Text = code; feedback.Text = ""; PairCode.Focus(); PairCode.SelectAll();
    } catch { feedback.Text = "Clipboard is unavailable. Click the code box and use Ctrl+V or right-click Paste."; }
  }
  internal bool Submit() {
    Uri site;
    if (!Uri.TryCreate(Address.Text.Trim(), UriKind.Absolute, out site) || site.Scheme != "https" ||
        !String.IsNullOrEmpty(site.UserInfo) || !String.IsNullOrEmpty(site.Query) || !String.IsNullOrEmpty(site.Fragment) || site.AbsolutePath != "/") {
      feedback.Text = "Enter the HTTPS site address only, for example https://cmmtools.site"; return false;
    }
    string code = NormalizeCode(PairCode.Text);
    if (code == null) { feedback.Text = "Paste one complete pairing code from Admin."; PairCode.Focus(); return false; }
    BaseUrl = site.GetLeftPart(UriPartial.Authority); Code = code;
    DialogResult = DialogResult.OK; return true;
  }
  internal static void SelfTest() {
    const string fixture = "AABBCCDDEEFF001122334455";
    using (var form = new PairingForm()) {
      form.Show(); Application.DoEvents();
      Clipboard.SetText(fixture.ToLowerInvariant());
      form.PairCode.Focus(); form.PairCode.Paste();
      if (form.PairCode.Text != fixture.ToLowerInvariant()) throw new Exception("Text field paste check failed.");
      form.PairCode.Clear(); Clipboard.SetText("Pairing code: " + fixture);
      form.PasteCode.PerformClick();
      if (form.PairCode.Text != fixture) throw new Exception("Paste button check failed.");
      form.Address.Text = "http://invalid.test";
      if (form.Submit()) throw new Exception("Address validation failed.");
      form.Address.Text = "https://cmmtools.site"; form.ConnectButton.PerformClick();
      if (form.DialogResult != DialogResult.OK || form.BaseUrl != "https://cmmtools.site" || form.Code != fixture)
        throw new Exception("Pairing window submission check failed.");
      if (NormalizeCode(fixture + fixture) != null || NormalizeCode("not a code") != null)
        throw new Exception("Pairing code validation failed.");
      Clipboard.Clear();
    }
    Console.WriteLine("Windows pairing window: text paste, Paste button and validation OK");
  }
}
