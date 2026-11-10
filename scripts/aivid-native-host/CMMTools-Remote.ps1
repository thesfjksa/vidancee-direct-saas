# CMMTools Windows Native Browser Relay — owner-operated AIVID viewport only.
# Not browser automation: no Playwright/CDP/Selenium/DOM/extension debugging.
# Requirements: Windows PowerShell 5.1, .NET Framework 4.7+, interactive Windows
# desktop; standard non-elevated Windows user with Microsoft Edge installed.
# Always run under a dedicated Windows user with no personal files/secrets.
$ErrorActionPreference='Stop'
[System.Net.ServicePointManager]::SecurityProtocol=[System.Net.SecurityProtocolType]::Tls12
$origin='https://cmmtools.site'
$api=$origin+'/api/aivid-native/host/'
$token=$null
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$native=@'
using System;
using System.Text;
using System.Linq;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class CMMWindowsBrowser {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; public int Width { get { return Right-Left; } } public int Height { get { return Bottom-Top; } } }
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder b,int max);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder b,int max);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT rect);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint id);
 [DllImport("user32.dll")] public static extern bool EnumWindows(WinEnum cb,IntPtr data);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent,WinEnum cb,IntPtr data);
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr info);
 [DllImport("user32.dll")] public static extern void keybd_event(byte vk,byte scan,uint flags,UIntPtr extra);
 [DllImport("user32.dll",SetLastError=true)] public static extern uint SendInput(uint n,INPUT[] inputs,int size);
 public delegate bool WinEnum(IntPtr hwnd,IntPtr data);
 [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr extra; }
 [StructLayout(LayoutKind.Explicit)] public struct UNION {
   [FieldOffset(0)]public KEYBDINPUT ki;[FieldOffset(0)]public MOUSEINPUT mi;
 }
 [StructLayout(LayoutKind.Sequential)] public struct INPUT {public uint type;public UNION data;}
 public static string Title(IntPtr h){var b=new StringBuilder(500);GetWindowText(h,b,b.Capacity);return b.ToString();}
 public static bool IsEdge(IntPtr h){
   if(h==IntPtr.Zero||!IsWindowVisible(h))return false;
   uint id;GetWindowThreadProcessId(h,out id);
   try{return Process.GetProcessById((int)id).ProcessName.Equals("msedge",StringComparison.OrdinalIgnoreCase);}catch{return false;}
 }
 public static IntPtr FindAividWindow(){
   IntPtr best=IntPtr.Zero;int bestArea=0;
   EnumWindows(delegate(IntPtr h,IntPtr unused){
     if(!IsEdge(h))return true;
     if(Title(h).IndexOf("aivid",StringComparison.OrdinalIgnoreCase)<0)return true;
     RECT r;if(!GetWindowRect(h,out r)||r.Width<500||r.Height<320)return true;
     int area=r.Width*r.Height;if(area>bestArea){best=h;bestArea=area;}
     return true;
   },IntPtr.Zero);
   return best;
 }
 public static RECT GetDocumentFallback(IntPtr window) {
   RECT best=new RECT();int bestArea=0;
   EnumChildWindows(window,delegate(IntPtr h,IntPtr unused){
     var b=new StringBuilder(120);GetClassName(h,b,b.Capacity);
     if(b.ToString().IndexOf("Chrome_RenderWidgetHostHWND",StringComparison.OrdinalIgnoreCase)<0)return true;
     RECT r;
     if(!IsWindowVisible(h)||!GetWindowRect(h,out r)||r.Width<320||r.Height<200)return true;
     int area=r.Width*r.Height;if(area>bestArea){best=r;bestArea=area;}
     return true;
   },IntPtr.Zero);
   return best;
 }
 public static void Click(int x,int y){
   SetCursorPos(x,y);mouse_event(0x0002,0,0,0,UIntPtr.Zero);System.Threading.Thread.Sleep(45);mouse_event(0x0004,0,0,0,UIntPtr.Zero);
 }
 public static void Wheel(int delta){
   mouse_event(0x0800,0,0,unchecked((uint)(delta*120)),UIntPtr.Zero);
 }
 public static void Key(int key) {
   keybd_event((byte)key,0,0,UIntPtr.Zero);System.Threading.Thread.Sleep(28);
   keybd_event((byte)key,0,2,UIntPtr.Zero);
 }
 public static void Text(string text) {
   foreach(char ch in text){
     var down=new INPUT{type=1,data=new UNION{ki=new KEYBDINPUT{wVk=0,wScan=(ushort)ch,dwFlags=0x0004}}};
     var up=new INPUT{type=1,data=new UNION{ki=new KEYBDINPUT{wVk=0,wScan=(ushort)ch,dwFlags=0x0004|0x0002}}};
     var keys=new []{down,up};
     if(SendInput((uint)keys.Length,keys,Marshal.SizeOf(typeof(INPUT)))!=2)throw new InvalidOperationException("Windows rejected synthetic Unicode keyboard input.");
   }
 }
}
'@
Add-Type -TypeDefinition $native -Language CSharp -ReferencedAssemblies 'System.dll','System.Core.dll'
[CMMWindowsBrowser]::SetProcessDPIAware()|Out-Null
function Get-AividWindow {
  $h=[CMMWindowsBrowser]::FindAividWindow()
  if($h -eq [IntPtr]::Zero){throw 'No AIVID Edge window found. Sign in normally in Edge and keep its AIVID page open.'}
  return $h
}
function Get-WebViewport([IntPtr]$h){
  if(-not [CMMWindowsBrowser]::IsEdge($h)){throw 'AIVID browser window is no longer active.'}
  if([CMMWindowsBrowser]::GetForegroundWindow() -ne $h){throw 'Bring the AIVID Edge window to the foreground to enable sharing.'}
  if(([CMMWindowsBrowser]::Title($h) -notmatch '(?i)aivid')){throw 'Browser is no longer on a named AIVID page.'}
  $best=$null;$maxArea=0
  try{
    $root=[System.Windows.Automation.AutomationElement]::FromHandle($h)
    $condition=New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Document)
    $docs=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition)
    foreach($doc in $docs){
      $r=$doc.Current.BoundingRectangle
      if($r.Width -lt 320 -or $r.Height -lt 200 -or $r.Width -gt 5000 -or $r.Height -gt 3000) {continue}
      $area=$r.Width*$r.Height
      if($area -gt $maxArea){$best=$r;$maxArea=$area}
    }
  }catch{}
  if($null -eq $best) {
    # Window chrome is NEVER a fallback: only a separately identified tab
    # renderer area can be captured if Windows UI Automation cannot find Document.
    $r=[CMMWindowsBrowser]::GetDocumentFallback($h)
    if($r.Width -lt 320 -or $r.Height -lt 200){throw 'Edge did not expose the webpage-only viewport. Remote sharing is safely paused.'}
    return @{Left=$r.Left;Top=$r.Top;Width=$r.Width;Height=$r.Height}
  }
  return @{Left=[Math]::Ceiling($best.Left);Top=[Math]::Ceiling($best.Top);
    Width=[Math]::Floor($best.Width);Height=[Math]::Floor($best.Height)}
}
function Take-Jpeg($rect){
  $width=[int]$rect.Width;$height=[int]$rect.Height
  if($width -lt 320 -or $height -lt 200 -or $width -gt 5000 -or $height -gt 3000){throw 'Invalid webpage viewport.'}
  $source=New-Object System.Drawing.Bitmap($width,$height)
  $g=[System.Drawing.Graphics]::FromImage($source)
  try{$g.CopyFromScreen([int]$rect.Left,[int]$rect.Top,0,0,$source.Size,[System.Drawing.CopyPixelOperation]::SourceCopy)}
  finally{$g.Dispose()}
  $w=[Math]::Min(1280,$width)
  $h=[Math]::Max(200,[Math]::Round($height*($w/[double]$width)))
  $target=New-Object System.Drawing.Bitmap($w,$h)
  $drawing=[System.Drawing.Graphics]::FromImage($target)
  try{
    $drawing.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
    $drawing.DrawImage($source,0,0,$w,$h)
  }finally{$drawing.Dispose();$source.Dispose()}
  try{
    $codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|Where-Object{$_.MimeType -eq 'image/jpeg'}|Select-Object -First 1
    foreach($quality in @(44,30,18)){
      $mem=New-Object System.IO.MemoryStream
      $params=New-Object System.Drawing.Imaging.EncoderParameters(1)
      $params.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter(
        [System.Drawing.Imaging.Encoder]::Quality,[long]$quality)
      try{$target.Save($mem,$codec,$params);$bytes=$mem.ToArray()}
      finally{$params.Dispose();$mem.Dispose()}
      if($bytes.Length -le 490*1024){return @{Bytes=$bytes;Width=$w;Height=$h}}
    }
    throw 'JPEG preview too large; reduce Edge window size.'
  }finally{$target.Dispose()}
}
function Send-HostRequest([string]$path,[string]$method,[object]$body=$null,[hashtable]$extra=@{}){
  $headers=@{};if($token){$headers.Authorization='Bearer '+$token}
  foreach($key in $extra.Keys){$headers[$key]=$extra[$key]}
  $params=@{Uri=$api+$path;Method=$method;TimeoutSec=15;Headers=$headers;UseBasicParsing=$true}
  if($null -ne $body){
    if($body -is [byte[]]){$params.Body=$body;$params.ContentType='image/jpeg'}
    else{$params.Body=($body|ConvertTo-Json -Depth 5 -Compress);$params.ContentType='application/json'}
  }
  return Invoke-RestMethod @params
}
function Apply-RemoteInput($command,[IntPtr]$target){
  if($null -eq $command){return}
  $r=Get-WebViewport $target # fail closed if a file picker, another app, or Chrome toolbar takes focus.
  switch([string]$command.action){
    'click' {
      $x=[int]$command.x;$y=[int]$command.y
      if($x -lt 0 -or $x -gt 10000 -or $y -lt 0 -or $y -gt 10000){throw 'Click rejected.'}
      $px=[int]($r.Left+[Math]::Min($r.Width-1,[Math]::Floor($r.Width*$x/10000.0)))
      $py=[int]($r.Top+[Math]::Min($r.Height-1,[Math]::Floor($r.Height*$y/10000.0)))
      [CMMWindowsBrowser]::Click($px,$py)
    }
    'wheel' {
      $delta=[int]$command.delta
      if([Math]::Abs($delta) -gt 3 -or $delta -eq 0){throw 'Scroll rejected.'}
      [CMMWindowsBrowser]::Wheel($delta)
    }
    'type' {
      $text=[string]$command.text
      if($text.Length -lt 1 -or $text.Length -gt 256 -or $text -match '[\x00-\x08\x0b-\x1f\x7f]'){throw 'Typing rejected.'}
      [CMMWindowsBrowser]::Text($text)
    }
    'key' {
      $codes=@{Enter=13;Tab=9;Backspace=8;Delete=46;ArrowUp=38;ArrowDown=40;
        ArrowLeft=37;ArrowRight=39;Home=36;End=35;Escape=27}
      $key=[string]$command.key
      if(-not $codes.ContainsKey($key)){throw 'Keyboard shortcut rejected.'}
      [CMMWindowsBrowser]::Key([int]$codes[$key])
    }
    default {throw 'Unexpected remote command.'}
  }
}
function Main {
  $id=[System.Security.Principal.WindowsIdentity]::GetCurrent()
  $principal=New-Object System.Security.Principal.WindowsPrincipal($id)
  if($principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)){
    throw 'For safety, do NOT run this helper elevated. Use a dedicated standard Windows account and retry.'
  }
  Write-Host ''
  Write-Host 'CMMTools native interactive browser relay (NO Playwright)' -ForegroundColor Cyan
  Write-Host 'Use a dedicated standard Windows account; keep AIVID in normal Edge.'
  Write-Host 'AIVID must be the active foreground window; all other windows are blocked.'
  Write-Host 'The remote viewer sees only the webpage viewport; never the address bar.'
  Write-Host ''
  $window=Get-AividWindow
  Write-Host ('Detected AIVID window: '+[CMMWindowsBrowser]::Title($window))
  $pair=(Read-Host 'Paste one-time code from CMMTools Admin').Trim().ToUpperInvariant()
  if($pair -cnotmatch '^[A-F0-9]{32}$'){throw 'Invalid pairing code. Generate a fresh one in Admin.'}
  $p=Send-HostRequest 'pair' 'Post' @{code=$pair}
  if(-not $p.ok -or -not $p.token){throw 'CMMTools did not approve the pairing.'}
  $script:token=[string]$p.token
  Write-Host 'Paired. Click back into the AIVID Edge window now.' -ForegroundColor Green
  Write-Host 'Sharing ends after 90 minutes, an Admin Stop, or when you close this helper.'
  Write-Host 'File chooser popups are not remotely controllable in this version.'
  $lastImage=[DateTime]::MinValue;$lastWarning=''
  try{
    while($true){
      $poll=Send-HostRequest 'next' 'Get'
      if(-not $poll.ok){throw 'CMMTools remote session has ended.'}
      if($poll.action){try{Apply-RemoteInput $poll.action $window}catch{
        if($lastWarning -ne $_.Exception.Message){Write-Warning $_.Exception.Message;$lastWarning=$_.Exception.Message}
      }}
      if(([DateTime]::UtcNow-$lastImage).TotalMilliseconds -ge 1500){
        $lastImage=[DateTime]::UtcNow
        try{
          $rect=Get-WebViewport $window
          $jpg=Take-Jpeg $rect
          $reply=Send-HostRequest 'frame' 'Post' $jpg.Bytes @{'X-CMM-Width'=[string]$jpg.Width;'X-CMM-Height'=[string]$jpg.Height}
          if(-not $reply.ok){throw 'CMMTools rejected the webpage frame.'}
          $lastWarning=''
        }catch{
          if($lastWarning -ne $_.Exception.Message){Write-Warning $_.Exception.Message;$lastWarning=$_.Exception.Message}
        }
      }
      Start-Sleep -Milliseconds 220
    }
  }finally{
    if($script:token){try{Send-HostRequest 'stop' 'Post' @{}|Out-Null}catch{}}
    $script:token=$null
  }
}
try{Main}catch{
  Write-Host ('Stopped: '+$_.Exception.Message) -ForegroundColor Yellow
  Write-Host 'Use Admin Stop Windows Host to revoke access if necessary.'
}
Read-Host 'Press Enter to close the helper'|Out-Null
