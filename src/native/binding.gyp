{
  "targets": [
    {
      "target_name": "wasapi_capture",
      "sources": ["wasapi_capture.cpp"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='win'", {
          "libraries": [
            "-lole32",
            "-loleaut32",
            "-luuid",
            "-lksuser"
          ]
        }]
      ]
    }
  ]
}
