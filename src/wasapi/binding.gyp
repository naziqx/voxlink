{
  "targets": [
    {
      "target_name": "wasapi_audio",
      "sources": ["wasapi_audio.c"],
      "include_dirs": [],
      "libraries": ["-lole32", "-loleaut32", "-lmmdevapi"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": ["/EHsc"]
        }
      },
      "conditions": [
        ["OS=='win'", {
          "libraries": ["ole32.lib", "oleaut32.lib", "mmdevapi.lib"]
        }]
      ]
    }
  ]
}
