// 用法：swift ocr.swift /path/to/image
// 输出：{"text":"识别到的文字"}
import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1,
      let img = NSImage(contentsOfFile: args[1]),
      let tiff = img.tiffRepresentation,
      let bmp = NSBitmapImageRep(data: tiff),
      let cg = bmp.cgImage else {
    print("{\"text\":\"\"}")
    exit(0)
}

let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.recognitionLanguages = ["zh-Hans", "en-US"]
req.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
try? handler.perform([req])

var lines: [String] = []
if let obs = req.results {
    for o in obs {
        if let t = o.topCandidates(1).first { lines.append(t.string) }
    }
}
let text = lines.joined(separator: "\n")
let data = try! JSONSerialization.data(withJSONObject: ["text": text], options: [])
print(String(data: data, encoding: .utf8)!)
