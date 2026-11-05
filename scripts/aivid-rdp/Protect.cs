using System;
using System.Security.Cryptography;
using System.Text;
internal static class Protect {
  public static int Main(string[] args) {
    try {
      if (args.Length != 1) return 1;
      string input = Console.In.ReadToEnd();
      if (input.Length > 32768) return 1;
      byte[] entropy = Encoding.UTF8.GetBytes("cmmtools-aivid-agent/v2");
      if (args[0] == "protect") Console.Write(Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(input), entropy, DataProtectionScope.CurrentUser)));
      else if (args[0] == "unprotect") Console.Write(Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(input), entropy, DataProtectionScope.CurrentUser)));
      else return 1;
      return 0;
    } catch { Console.Error.WriteLine("Windows credential protection failed."); return 1; }
  }
}
