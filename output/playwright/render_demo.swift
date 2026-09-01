import AppKit
import AVFoundation
import CoreGraphics
import CoreVideo
import Foundation

enum DemoRenderError: Error {
    case badArguments
    case missingImage(String)
    case missingTrack(String)
    case cannotCreateBuffer
    case cannotCreateContext
    case cannotCreateExporter
    case writerFailed(String)
}

@main
struct DemoRenderer {
    static let width = 1280
    static let height = 800
    static let framesPerSecond: Int32 = 30

    static func main() async throws {
        guard CommandLine.arguments.count >= 5 else {
            throw DemoRenderError.badArguments
        }

        let audioURL = URL(fileURLWithPath: CommandLine.arguments[1])
        let intermediateURL = URL(fileURLWithPath: CommandLine.arguments[2])
        let outputURL = URL(fileURLWithPath: CommandLine.arguments[3])
        let imageURLs = CommandLine.arguments.dropFirst(4).map(URL.init(fileURLWithPath:))
        let images = try imageURLs.map(loadImage)

        let audioAsset = AVURLAsset(url: audioURL)
        let audioDuration = try await audioAsset.load(.duration)
        let durationSeconds = max(1, CMTimeGetSeconds(audioDuration))

        try? FileManager.default.removeItem(at: intermediateURL)
        try? FileManager.default.removeItem(at: outputURL)
        try await renderVideo(images: images, durationSeconds: durationSeconds, outputURL: intermediateURL)
        try await mux(videoURL: intermediateURL, audioURL: audioURL, outputURL: outputURL)
        try await verifyAndWritePoster(videoURL: outputURL, durationSeconds: durationSeconds)
        try? FileManager.default.removeItem(at: intermediateURL)
    }

    static func loadImage(url: URL) throws -> CGImage {
        guard let image = NSImage(contentsOf: url),
              let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            throw DemoRenderError.missingImage(url.path)
        }
        return cgImage
    }

    static func renderVideo(images: [CGImage], durationSeconds: Double, outputURL: URL) async throws {
        let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mov)
        let input = AVAssetWriterInput(
            mediaType: .video,
            outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: width,
                AVVideoHeightKey: height,
                AVVideoCompressionPropertiesKey: [
                    AVVideoAverageBitRateKey: 4_000_000,
                    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
                ]
            ]
        )
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height
            ]
        )
        guard writer.canAdd(input) else {
            throw DemoRenderError.writerFailed("Cannot add the video input")
        }
        writer.add(input)
        guard writer.startWriting() else {
            throw DemoRenderError.writerFailed(writer.error?.localizedDescription ?? "Writer did not start")
        }
        writer.startSession(atSourceTime: .zero)

        let totalFrames = Int(ceil(durationSeconds * Double(framesPerSecond)))
        let slideDuration = durationSeconds / Double(images.count)
        for frame in 0..<totalFrames {
            while !input.isReadyForMoreMediaData {
                try await Task.sleep(for: .milliseconds(2))
            }
            guard let buffer = makeFrame(
                images: images,
                seconds: Double(frame) / Double(framesPerSecond),
                slideDuration: slideDuration
            ) else {
                throw DemoRenderError.cannotCreateBuffer
            }
            let time = CMTime(value: Int64(frame), timescale: framesPerSecond)
            guard adaptor.append(buffer, withPresentationTime: time) else {
                throw DemoRenderError.writerFailed(writer.error?.localizedDescription ?? "Frame append failed")
            }
        }

        input.markAsFinished()
        await writer.finishWriting()
        guard writer.status == .completed else {
            throw DemoRenderError.writerFailed(writer.error?.localizedDescription ?? "Writer did not finish")
        }
    }

    static func makeFrame(images: [CGImage], seconds: Double, slideDuration: Double) -> CVPixelBuffer? {
        var pixelBuffer: CVPixelBuffer?
        let attributes = [
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true
        ] as CFDictionary
        guard CVPixelBufferCreate(
            kCFAllocatorDefault,
            width,
            height,
            kCVPixelFormatType_32ARGB,
            attributes,
            &pixelBuffer
        ) == kCVReturnSuccess, let pixelBuffer else {
            return nil
        }

        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        guard let context = CGContext(
            data: CVPixelBufferGetBaseAddress(pixelBuffer),
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue
        ) else {
            return nil
        }

        let slidePosition = seconds / slideDuration
        let currentIndex = min(Int(slidePosition), images.count - 1)
        let localSeconds = seconds - Double(currentIndex) * slideDuration
        let transitionDuration = min(0.7, slideDuration / 5)
        let nextIndex = min(currentIndex + 1, images.count - 1)
        let transition = nextIndex == currentIndex
            ? 0
            : max(0, min(1, (localSeconds - (slideDuration - transitionDuration)) / transitionDuration))

        context.setFillColor(CGColor(gray: 0.08, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let destination = CGRect(x: 0, y: 0, width: width, height: height)
        context.setAlpha(1)
        context.draw(images[currentIndex], in: destination)
        if transition > 0 {
            context.setAlpha(transition)
            context.draw(images[nextIndex], in: destination)
        }
        return pixelBuffer
    }

    static func mux(videoURL: URL, audioURL: URL, outputURL: URL) async throws {
        let videoAsset = AVURLAsset(url: videoURL)
        let audioAsset = AVURLAsset(url: audioURL)
        guard let sourceVideo = try await videoAsset.loadTracks(withMediaType: .video).first else {
            throw DemoRenderError.missingTrack("video")
        }
        guard let sourceAudio = try await audioAsset.loadTracks(withMediaType: .audio).first else {
            throw DemoRenderError.missingTrack("audio")
        }
        let duration = try await audioAsset.load(.duration)
        let composition = AVMutableComposition()
        guard let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
              let audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw DemoRenderError.missingTrack("composition")
        }
        try videoTrack.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: sourceVideo, at: .zero)
        try audioTrack.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: sourceAudio, at: .zero)

        guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
            throw DemoRenderError.cannotCreateExporter
        }
        try await exporter.export(to: outputURL, as: .mp4)
    }

    static func verifyAndWritePoster(videoURL: URL, durationSeconds: Double) async throws {
        let asset = AVURLAsset(url: videoURL)
        let duration = try await asset.load(.duration)
        let videoTracks = try await asset.loadTracks(withMediaType: .video)
        let audioTracks = try await asset.loadTracks(withMediaType: .audio)
        guard let videoTrack = videoTracks.first else {
            throw DemoRenderError.missingTrack("final video")
        }
        guard !audioTracks.isEmpty else {
            throw DemoRenderError.missingTrack("final audio")
        }
        let size = try await videoTrack.load(.naturalSize)
        let seconds = CMTimeGetSeconds(duration)
        guard seconds > 1, Int(size.width) == width, Int(size.height) == height else {
            throw DemoRenderError.writerFailed("Final media metadata did not match the render contract")
        }

        let imageGenerator = AVAssetImageGenerator(asset: asset)
        imageGenerator.appliesPreferredTrackTransform = true
        let posterTime = CMTime(seconds: min(seconds - 1, durationSeconds * 0.68), preferredTimescale: 600)
        let (poster, _) = try await imageGenerator.image(at: posterTime)
        let posterData = NSBitmapImageRep(cgImage: poster).representation(using: .png, properties: [:])
        let posterURL = videoURL.deletingPathExtension().appendingPathExtension("poster.png")
        try posterData?.write(to: posterURL)
        print("PASS · narrated demo \(String(format: "%.1f", seconds))s · \(width)×\(height) · video 1 · audio \(audioTracks.count)")
        print("PASS · demo poster written to \(posterURL.path)")
    }
}
